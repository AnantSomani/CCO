import type { Db } from '@/db/client';
import { insertApproval } from '@/db/queries/approvals';
import { getEventForApproval, updateEventStatus } from '@/db/queries/events';
import { getUserBySlackUserId } from '@/db/queries/users';
import { getWorkspaceBySlackTeamId } from '@/db/queries/workspaces';
import { log as defaultLog } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';
import { buildApprovalResolvedDM } from '@/slack/blocks/approval-dm';
import { buildModifyModal } from '@/slack/blocks/modify-modal';
import type { GetSlackClient } from '@/slack/client';
import { EVENT_NAME_DAY_OF_SCHEDULED } from '@/slack/ids';
import type { BlockActionsPayload } from '@/slack/schemas';

type Logger = { info: (m: string, meta?: Record<string, unknown>) => void };

type EventEmitter = {
  send: (event: { name: string; ts?: number; data: Record<string, unknown> }) => Promise<unknown>;
};

export type ActionHandlerCtx = {
  db: Db;
  getSlackClient: GetSlackClient;
  emitter: EventEmitter;
  log?: Logger;
};

type ButtonValue = { eventId: string; suggestionId?: string | null };

const parseButtonValue = (raw: string | undefined): ButtonValue | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ButtonValue;
    if (typeof parsed.eventId !== 'string' || !parsed.eventId) return null;
    return parsed;
  } catch {
    return null;
  }
};

// v1 simplification per ARCHITECTURE.md: schedule day-of post for 14:00 UTC
// on the event date. Per-workspace local-time delivery is a v2 polish.
const dayOfDeliveryMs = (eventDateYmd: string): number => {
  const [y, m, d] = eventDateYmd.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, 14, 0, 0);
};

// Common pre-flight: resolve workspace + user, load event bundle, parse the
// button value. Anything missing → return a typed error the caller can log.
type Resolved = {
  workspaceId: string;
  userId: string;
  bundle: NonNullable<Awaited<ReturnType<typeof getEventForApproval>>>;
  buttonValue: ButtonValue;
};

const resolve = async (
  ctx: ActionHandlerCtx,
  payload: BlockActionsPayload,
): Promise<Result<Resolved, string>> => {
  const action = payload.actions[0];
  if (!action) return err('no action in payload');
  const buttonValue = parseButtonValue(action.value);
  if (!buttonValue) return err('invalid button value');

  const workspace = await getWorkspaceBySlackTeamId(ctx.db, payload.team.id);
  if (!workspace) return err(`unknown workspace: ${payload.team.id}`);

  const user = await getUserBySlackUserId(ctx.db, workspace.id, payload.user.id);
  if (!user) return err(`unknown user: ${payload.user.id} in workspace ${workspace.id}`);

  const bundle = await getEventForApproval(ctx.db, buttonValue.eventId);
  if (!bundle) return err(`unknown event: ${buttonValue.eventId}`);

  if (bundle.event.workspaceId !== workspace.id) {
    return err(`cross-workspace event access blocked: ${buttonValue.eventId}`);
  }

  return ok({ workspaceId: workspace.id, userId: user.id, bundle, buttonValue });
};

const updateApprovalDm = async (
  ctx: ActionHandlerCtx,
  workspaceId: string,
  channelId: string | null,
  ts: string | null,
  message: ReturnType<typeof buildApprovalResolvedDM>,
): Promise<void> => {
  if (!channelId || !ts) return;
  const slack = await ctx.getSlackClient(workspaceId);
  if (!slack.ok) return;
  await slack.value.chatUpdate({
    channel: channelId,
    ts,
    text: message.text,
    blocks: message.blocks,
  });
};

export const handleApproveEvent = async (
  ctx: ActionHandlerCtx,
  payload: BlockActionsPayload,
): Promise<Result<{ status: 'approved' | 'already_decided' }, string>> => {
  const log = ctx.log ?? defaultLog;
  const r = await resolve(ctx, payload);
  if (!r.ok) return r;
  const { workspaceId, userId, bundle, buttonValue } = r.value;

  const chosen =
    bundle.suggestions.find((s) => s.id === buttonValue.suggestionId) ?? bundle.suggestions[0];

  const approval = await insertApproval(ctx.db, {
    eventId: bundle.event.id,
    approverUserId: userId,
    decision: 'approved',
    chosenSuggestionId: chosen?.id ?? null,
    approvedBudgetCents: chosen?.estimatedCostCents ?? null,
  });

  if (!approval) {
    // Double-tap — someone (or this same admin from two devices) already
    // decided. Don't double-schedule; just refresh the DM to current state.
    log.info('approve no-op: approval already exists', { eventId: bundle.event.id });
    return ok({ status: 'already_decided' });
  }

  await updateEventStatus(ctx.db, bundle.event.id, 'approved');

  await ctx.emitter.send({
    name: EVENT_NAME_DAY_OF_SCHEDULED,
    ts: dayOfDeliveryMs(bundle.event.eventDate),
    data: { eventId: bundle.event.id },
  });

  await updateApprovalDm(
    ctx,
    workspaceId,
    bundle.event.approvalDmChannelId,
    bundle.event.approvalDmTs,
    buildApprovalResolvedDM({
      status: 'approved',
      gestureSummary: chosen?.gestureSummary ?? '(no gesture)',
    }),
  );

  log.info('event approved', {
    eventId: bundle.event.id,
    chosenSuggestionId: chosen?.id,
    eventDate: bundle.event.eventDate,
  });

  return ok({ status: 'approved' });
};

export const handleSkipEvent = async (
  ctx: ActionHandlerCtx,
  payload: BlockActionsPayload,
): Promise<Result<{ status: 'skipped' | 'already_decided' }, string>> => {
  const log = ctx.log ?? defaultLog;
  const r = await resolve(ctx, payload);
  if (!r.ok) return r;
  const { workspaceId, userId, bundle } = r.value;

  const approval = await insertApproval(ctx.db, {
    eventId: bundle.event.id,
    approverUserId: userId,
    decision: 'skipped',
  });

  if (!approval) {
    log.info('skip no-op: approval already exists', { eventId: bundle.event.id });
    return ok({ status: 'already_decided' });
  }

  await updateEventStatus(ctx.db, bundle.event.id, 'skipped');

  await updateApprovalDm(
    ctx,
    workspaceId,
    bundle.event.approvalDmChannelId,
    bundle.event.approvalDmTs,
    buildApprovalResolvedDM({ status: 'skipped' }),
  );

  log.info('event skipped', { eventId: bundle.event.id });

  return ok({ status: 'skipped' });
};

export const handleModifyEvent = async (
  ctx: ActionHandlerCtx,
  payload: BlockActionsPayload,
): Promise<Result<{ status: 'modal_opened' }, string>> => {
  const log = ctx.log ?? defaultLog;
  const r = await resolve(ctx, payload);
  if (!r.ok) return r;
  const { workspaceId, bundle } = r.value;

  const slack = await ctx.getSlackClient(workspaceId);
  if (!slack.ok) return err(`slack client unavailable: ${slack.error}`);

  const view = buildModifyModal({
    event: { id: bundle.event.id, kind: bundle.event.kind, years: bundle.event.years },
    person: { name: bundle.person.name },
    suggestions: bundle.suggestions.map((s) => ({
      gestureSummary: s.gestureSummary,
      estimatedCostCents: s.estimatedCostCents,
    })),
    privateMetadata: JSON.stringify({ eventId: bundle.event.id }),
    defaultBudgetCents: bundle.workspace.defaultBudgetCents,
  });

  const opened = await slack.value.viewsOpen({ trigger_id: payload.trigger_id, view });
  if (!opened.ok) return err(`views.open failed: ${opened.error}`);

  log.info('modify modal opened', { eventId: bundle.event.id, viewId: opened.value.viewId });

  return ok({ status: 'modal_opened' });
};
