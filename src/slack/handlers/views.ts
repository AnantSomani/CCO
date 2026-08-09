import { z } from 'zod';
import type { Db } from '@/db/client';
import { insertApproval } from '@/db/queries/approvals';
import { getEventForApproval, updateEventStatus } from '@/db/queries/events';
import { getUserBySlackUserId } from '@/db/queries/users';
import { getWorkspaceBySlackTeamId } from '@/db/queries/workspaces';
import { log as defaultLog } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';
import { buildApprovalResolvedDM } from '@/slack/blocks/approval-dm';
import type { GetSlackClient } from '@/slack/client';
import {
  BLOCK_MODIFY_BUDGET,
  BLOCK_MODIFY_GESTURE,
  EVENT_NAME_DAY_OF_SCHEDULED,
  INPUT_BUDGET,
  INPUT_GESTURE,
} from '@/slack/ids';
import type { ViewSubmissionPayload } from '@/slack/schemas';

type Logger = { info: (m: string, meta?: Record<string, unknown>) => void };

type EventEmitter = {
  send: (event: { name: string; ts?: number; data: Record<string, unknown> }) => Promise<unknown>;
};

export type ViewHandlerCtx = {
  db: Db;
  getSlackClient: GetSlackClient;
  emitter: EventEmitter;
  log?: Logger;
};

// View payload accessors: state.values is keyed [block_id][action_id]. We pin
// to our known block + input ids from src/slack/ids.ts.
const extractGesture = (values: ViewSubmissionPayload['view']['state']['values']): string | null =>
  values[BLOCK_MODIFY_GESTURE]?.[INPUT_GESTURE]?.value ?? null;

const extractBudgetCents = (
  values: ViewSubmissionPayload['view']['state']['values'],
): number | null => {
  const raw = values[BLOCK_MODIFY_BUDGET]?.[INPUT_BUDGET]?.value;
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
};

const dayOfDeliveryMs = (eventDateYmd: string): number => {
  const [y, m, d] = eventDateYmd.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, 14, 0, 0);
};

const privateMetadataSchema = z.object({ eventId: z.string().min(1) });

export type ModifySubmitResult =
  | { status: 'approved_modified' }
  | { status: 'already_decided' }
  | { status: 'validation_error'; errors: Record<string, string> };

export const handleModifySubmit = async (
  ctx: ViewHandlerCtx,
  payload: ViewSubmissionPayload,
): Promise<Result<ModifySubmitResult, string>> => {
  const log = ctx.log ?? defaultLog;

  let parsedMeta: { eventId: string };
  try {
    const raw = JSON.parse(payload.view.private_metadata) as unknown;
    const result = privateMetadataSchema.safeParse(raw);
    if (!result.success) return err('invalid private_metadata');
    parsedMeta = result.data;
  } catch {
    return err('invalid private_metadata');
  }

  const gesture = extractGesture(payload.view.state.values)?.trim();
  const budgetCents = extractBudgetCents(payload.view.state.values);

  const errors: Record<string, string> = {};
  if (!gesture) errors[BLOCK_MODIFY_GESTURE] = 'Tell me what gesture to send.';
  if (budgetCents === null) errors[BLOCK_MODIFY_BUDGET] = 'Enter a non-negative dollar amount.';
  if (Object.keys(errors).length > 0) {
    return ok({ status: 'validation_error', errors });
  }
  if (!gesture || budgetCents === null) {
    // Narrowing guard for TS; mirrors the validation check above.
    return ok({ status: 'validation_error', errors });
  }

  const workspace = await getWorkspaceBySlackTeamId(ctx.db, payload.team.id);
  if (!workspace) return err(`unknown workspace: ${payload.team.id}`);

  const user = await getUserBySlackUserId(ctx.db, workspace.id, payload.user.id);
  if (!user) return err(`unknown user: ${payload.user.id}`);
  if (!user.isAdmin) return err(`non-admin user cannot modify events: ${payload.user.id}`);

  const bundle = await getEventForApproval(ctx.db, parsedMeta.eventId);
  if (!bundle) return err(`unknown event: ${parsedMeta.eventId}`);
  if (bundle.event.workspaceId !== workspace.id) {
    return err(`cross-workspace event access blocked: ${parsedMeta.eventId}`);
  }

  const approval = await insertApproval(ctx.db, {
    eventId: bundle.event.id,
    approverUserId: user.id,
    decision: 'modified',
    customGestureText: gesture,
    approvedBudgetCents: budgetCents,
  });

  if (!approval) {
    log.info('modify no-op: approval already exists', { eventId: bundle.event.id });
    return ok({ status: 'already_decided' });
  }

  await updateEventStatus(ctx.db, bundle.event.id, 'approved');

  await ctx.emitter.send({
    name: EVENT_NAME_DAY_OF_SCHEDULED,
    ts: dayOfDeliveryMs(bundle.event.eventDate),
    data: { eventId: bundle.event.id },
  });

  if (bundle.event.approvalDmChannelId && bundle.event.approvalDmTs) {
    const slack = await ctx.getSlackClient(workspace.id);
    if (slack.ok) {
      const updated = buildApprovalResolvedDM({
        status: 'modified',
        customGestureText: gesture,
      });
      await slack.value.chatUpdate({
        channel: bundle.event.approvalDmChannelId,
        ts: bundle.event.approvalDmTs,
        text: updated.text,
        blocks: updated.blocks,
      });
    }
  }

  log.info('event approved via modify', {
    eventId: bundle.event.id,
    budgetCents,
    eventDate: bundle.event.eventDate,
  });

  return ok({ status: 'approved_modified' });
};
