import type { Db } from '@/db/client';
import {
  approveAgentAction,
  cancelCompletedSandboxAction,
  getAgentAction,
  rejectAgentAction,
} from '@/db/queries/agent-operations';
import { isWorkspaceAdmin } from '@/db/queries/users';
import { getWorkspaceBySlackTeamId } from '@/db/queries/workspaces';
import { err, ok, type Result } from '@/lib/result';
import { buildAgentActionResolved } from '@/slack/blocks/agent-action';
import type { GetSlackClient } from '@/slack/client';
import { EVENT_NAME_AGENT_ACTION_APPROVED } from '@/slack/ids';
import type { BlockActionsPayload } from '@/slack/schemas';

type EventEmitter = {
  send: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
};

type AgentActionHandlerContext = {
  db: Db;
  getSlackClient: GetSlackClient;
  emitter: EventEmitter;
};

const parseActionId = (payload: BlockActionsPayload): string | null => {
  const raw = payload.actions[0]?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { actionId?: unknown };
    return typeof parsed.actionId === 'string' && parsed.actionId ? parsed.actionId : null;
  } catch {
    return null;
  }
};

const resolveAuthorizedAction = async (
  ctx: AgentActionHandlerContext,
  payload: BlockActionsPayload,
) => {
  const actionId = parseActionId(payload);
  if (!actionId) return err('invalid agent action button value');
  const workspace = await getWorkspaceBySlackTeamId(ctx.db, payload.team.id);
  if (!workspace) return err(`unknown workspace: ${payload.team.id}`);
  if (!(await isWorkspaceAdmin(ctx.db, workspace.id, payload.user.id))) {
    return err(`unauthorized agent action decision by ${payload.user.id}`);
  }
  const action = await getAgentAction(ctx.db, actionId);
  if (!action || action.workspaceId !== workspace.id) {
    return err(`unknown or cross-workspace agent action: ${actionId}`);
  }
  return ok({ action, workspace });
};

const updateConfirmation = async (
  ctx: AgentActionHandlerContext,
  workspaceId: string,
  channelId: string | null,
  messageTs: string | null,
  message: ReturnType<typeof buildAgentActionResolved>,
): Promise<void> => {
  if (!channelId || !messageTs) return;
  const slack = await ctx.getSlackClient(workspaceId);
  if (!slack.ok) return;
  await slack.value.chatUpdate({
    channel: channelId,
    ts: messageTs,
    text: message.text,
    blocks: message.blocks,
  });
};

export const handleApproveAgentAction = async (
  ctx: AgentActionHandlerContext,
  payload: BlockActionsPayload,
): Promise<Result<{ status: 'approved' | 'already_decided' }, string>> => {
  const resolved = await resolveAuthorizedAction(ctx, payload);
  if (!resolved.ok) return resolved;
  const { action, workspace } = resolved.value;
  const approved = await approveAgentAction(ctx.db, action.id, workspace.id, payload.user.id);
  if (!approved) return ok({ status: 'already_decided' });

  await ctx.emitter.send({
    name: EVENT_NAME_AGENT_ACTION_APPROVED,
    data: { actionId: approved.id },
  });
  await updateConfirmation(
    ctx,
    workspace.id,
    approved.confirmationChannelId,
    approved.confirmationMessageTs,
    buildAgentActionResolved({ summary: approved.summary, status: 'approved' }),
  );
  return ok({ status: 'approved' });
};

export const handleRejectAgentAction = async (
  ctx: AgentActionHandlerContext,
  payload: BlockActionsPayload,
): Promise<Result<{ status: 'rejected' | 'already_decided' }, string>> => {
  const resolved = await resolveAuthorizedAction(ctx, payload);
  if (!resolved.ok) return resolved;
  const { action, workspace } = resolved.value;
  const rejected = await rejectAgentAction(ctx.db, action.id, workspace.id, payload.user.id);
  if (!rejected) return ok({ status: 'already_decided' });

  await updateConfirmation(
    ctx,
    workspace.id,
    rejected.confirmationChannelId,
    rejected.confirmationMessageTs,
    buildAgentActionResolved({ summary: rejected.summary, status: 'rejected' }),
  );
  return ok({ status: 'rejected' });
};

export const handleCancelAgentAction = async (
  ctx: AgentActionHandlerContext,
  payload: BlockActionsPayload,
): Promise<Result<{ status: 'cancelled' | 'not_cancellable' }, string>> => {
  const resolved = await resolveAuthorizedAction(ctx, payload);
  if (!resolved.ok) return resolved;
  const { action, workspace } = resolved.value;
  const cancelled = await cancelCompletedSandboxAction(
    ctx.db,
    action.id,
    workspace.id,
    payload.user.id,
  );
  if (!cancelled) return ok({ status: 'not_cancellable' });

  await updateConfirmation(
    ctx,
    workspace.id,
    cancelled.confirmationChannelId,
    cancelled.confirmationMessageTs,
    buildAgentActionResolved({
      actionId: cancelled.id,
      kind: cancelled.kind,
      summary: cancelled.summary,
      status: 'cancelled',
      detail: 'Sandbox cancellation recorded. No vendor had been contacted.',
    }),
  );
  return ok({ status: 'cancelled' });
};
