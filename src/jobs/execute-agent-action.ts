import {
  sandboxEventPlanPayloadSchema,
  sandboxFoodOrderPayloadSchema,
  setCelebrationChannelPayloadSchema,
  setDefaultBudgetPayloadSchema,
} from '@/agent/command-types';
import type { Db } from '@/db/client';
import {
  beginAgentActionExecution,
  completeAgentAction,
  failAgentAction,
  getAgentAction,
} from '@/db/queries/agent-operations';
import { getWorkspaceById, setCelebrationChannel, setDefaultBudget } from '@/db/queries/workspaces';
import { err, ok, type Result } from '@/lib/result';
import { buildAgentActionResolved } from '@/slack/blocks/agent-action';
import type { GetSlackClient, SlackClient } from '@/slack/client';
import { EVENT_NAME_AGENT_ACTION_APPROVED } from '@/slack/ids';
import { inngest } from './client';

type RunAgentActionArgs = {
  db: Db;
  getSlackClient: GetSlackClient;
  actionId: string;
};

export const runAgentAction = async ({
  db,
  getSlackClient,
  actionId,
}: RunAgentActionArgs): Promise<Result<{ status: 'completed' | 'already_finished' }, string>> => {
  const existing = await getAgentAction(db, actionId);
  if (!existing) return err(`agent action not found: ${actionId}`);
  if (['completed', 'rejected', 'cancelled'].includes(existing.status)) {
    return ok({ status: 'already_finished' });
  }

  const workspace = await getWorkspaceById(db, existing.workspaceId);
  if (!workspace) return err(`workspace not found: ${existing.workspaceId}`);
  const slack = await getSlackClient(workspace.id);
  if (!slack.ok) return err(`slack client unavailable: ${slack.error}`);
  const action = await beginAgentActionExecution(db, actionId);
  if (!action) return err(`agent action is not approved: ${actionId}`);

  const execution = await execute(action, workspace.defaultBudgetCents, slack.value, db);
  if (!execution.ok) {
    await failAgentAction(db, action.id, execution.error);
    await updateActionMessage(
      slack.value,
      action.confirmationChannelId,
      action.confirmationMessageTs,
      buildAgentActionResolved({
        summary: action.summary,
        status: 'failed',
        detail: `Nothing was changed. Error: ${execution.error}`,
      }),
    );
    return execution;
  }

  await completeAgentAction(db, action.id, execution.value);
  await updateActionMessage(
    slack.value,
    action.confirmationChannelId,
    action.confirmationMessageTs,
    buildAgentActionResolved({
      actionId: action.id,
      kind: action.kind,
      summary: action.summary,
      status: 'completed',
      detail: formatExecutionDetail(action.kind, execution.value),
    }),
  );
  return ok({ status: 'completed' });
};

const execute = async (
  action: NonNullable<Awaited<ReturnType<typeof beginAgentActionExecution>>>,
  workspaceBudgetCents: number,
  slack: SlackClient,
  db: Db,
): Promise<Result<Record<string, unknown>, string>> => {
  switch (action.kind) {
    case 'set_default_budget': {
      const parsed = setDefaultBudgetPayloadSchema.safeParse(action.payload);
      if (!parsed.success) return err('invalid_budget_payload');
      await setDefaultBudget(db, action.workspaceId, parsed.data.amountCents);
      return ok({ amountCents: parsed.data.amountCents });
    }

    case 'set_celebration_channel': {
      const parsed = setCelebrationChannelPayloadSchema.safeParse(action.payload);
      if (!parsed.success) return err('invalid_channel_payload');
      const info = await slack.conversationsInfo(parsed.data.channelId);
      if (!info.ok) return err(`channel_lookup_failed:${info.error}`);
      if (!info.value.is_member) return err('bot_not_in_channel');
      await setCelebrationChannel(db, action.workspaceId, parsed.data.channelId);
      return ok({ channelId: parsed.data.channelId, channelName: info.value.name });
    }

    case 'sandbox_food_order': {
      const parsed = sandboxFoodOrderPayloadSchema.safeParse(action.payload);
      if (!parsed.success) return err('invalid_food_order_payload');
      if (parsed.data.estimatedCostCents > workspaceBudgetCents) {
        return err('estimate_exceeds_current_budget');
      }
      return ok({
        sandbox: true,
        mockOrderId: `sandbox-order-${action.id.slice(0, 8)}`,
        status: 'confirmed',
        restaurant: parsed.data.restaurant,
        deliveryAt: parsed.data.deliveryAt,
        estimatedCostCents: parsed.data.estimatedCostCents,
      });
    }

    case 'sandbox_event_plan': {
      const parsed = sandboxEventPlanPayloadSchema.safeParse(action.payload);
      if (!parsed.success) return err('invalid_event_plan_payload');
      if (parsed.data.estimatedCostCents > workspaceBudgetCents) {
        return err('estimate_exceeds_current_budget');
      }
      return ok({
        sandbox: true,
        mockPlanId: `sandbox-event-${action.id.slice(0, 8)}`,
        status: 'confirmed',
        title: parsed.data.title,
        eventAt: parsed.data.eventAt,
        estimatedCostCents: parsed.data.estimatedCostCents,
      });
    }
  }
};

const updateActionMessage = async (
  slack: {
    chatUpdate: (input: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    }) => Promise<Result<{ ts: string }, string>>;
  },
  channelId: string | null,
  messageTs: string | null,
  message: { text: string; blocks: unknown[] },
): Promise<void> => {
  if (!channelId || !messageTs) return;
  await slack.chatUpdate({
    channel: channelId,
    ts: messageTs,
    text: message.text,
    blocks: message.blocks,
  });
};

const formatExecutionDetail = (kind: string, result: Record<string, unknown>): string => {
  if (kind.startsWith('sandbox_')) {
    const id = result.mockOrderId ?? result.mockPlanId;
    return `Sandbox execution complete. Reference: \`${String(id)}\`. No vendor was contacted and no money was spent.`;
  }
  return 'The approved workspace setting was updated.';
};

export const executeAgentAction = inngest.createFunction(
  {
    id: 'execute-agent-action',
    retries: 3,
    triggers: [{ event: EVENT_NAME_AGENT_ACTION_APPROVED }],
    singleton: { key: 'event.data.actionId', mode: 'skip' },
  },
  async ({ event, step }) => {
    const data = event.data as { actionId?: string };
    if (!data.actionId) return { ok: false, error: 'missing actionId' };
    const result = await step.run('execute-approved-agent-action', async () => {
      const { db } = await import('@/db/client');
      const { getSlackClient } = await import('@/slack/client');
      return runAgentAction({ db, getSlackClient, actionId: data.actionId as string });
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true, ...result.value };
  },
);
