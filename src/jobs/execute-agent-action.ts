import {
  doorDashOrderPreviewPayloadSchema,
  sandboxEventPlanPayloadSchema,
  sandboxFoodOrderPayloadSchema,
  scheduleReminderPayloadSchema,
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
import { setArtifactStatus } from '@/db/queries/agent-sessions';
import { getWorkspaceById, setCelebrationChannel, setDefaultBudget } from '@/db/queries/workspaces';
import {
  buildDoorDashIntent,
  createDdCliClient,
  type DdCliClient,
} from '@/integrations/doordash/dd-cli-client';
import { env } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';
import { buildAgentActionResolved } from '@/slack/blocks/agent-action';
import type { GetSlackClient, SlackClient } from '@/slack/client';
import { EVENT_NAME_AGENT_ACTION_APPROVED, EVENT_NAME_AGENT_REMINDER_DUE } from '@/slack/ids';
import { inngest } from './client';

type ReminderEmitter = (input: {
  artifactId: string;
  workspaceId: string;
  fireAt: Date;
}) => Promise<void>;

type RunAgentActionArgs = {
  db: Db;
  getSlackClient: GetSlackClient;
  doorDash?: DdCliClient;
  emitReminder?: ReminderEmitter;
  actionId: string;
};

export const runAgentAction = async ({
  db,
  getSlackClient,
  doorDash,
  emitReminder,
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

  const execution = await execute(
    action,
    workspace.defaultBudgetCents,
    slack.value,
    db,
    doorDash,
    emitReminder,
  );
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
  doorDash?: DdCliClient,
  emitReminder?: ReminderEmitter,
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

    case 'doordash_order_preview': {
      if (!doorDash) return err('doordash_preview_disabled');
      const parsed = doorDashOrderPreviewPayloadSchema.safeParse(action.payload);
      if (!parsed.success) return err('invalid_doordash_preview_payload');
      if (parsed.data.estimatedCostCents > workspaceBudgetCents) {
        return err('estimate_exceeds_current_budget');
      }
      const intent = buildDoorDashIntent(
        'Help the workspace admin preview an approved team food order',
        action.summary,
      );
      const existingCarts = await doorDash.listCarts({
        storeId: parsed.data.storeId,
        intent,
      });
      if (!existingCarts.ok) return err(`doordash_cart_lookup_failed:${existingCarts.error}`);
      if (existingCarts.value.carts.length > 0)
        return err('doordash_existing_cart_requires_review');
      const added = await doorDash.addItems({
        storeId: parsed.data.storeId,
        menuId: parsed.data.menuId,
        items: parsed.data.items,
        intent,
      });
      if (!added.ok) return err(`doordash_cart_failed:${added.error}`);
      if (
        !added.value.success ||
        !added.value.cart_uuid ||
        (added.value.item_errors?.length ?? 0) > 0
      ) {
        return err('doordash_cart_items_need_review');
      }
      const preview = await doorDash.previewOrder({
        cartUuid: added.value.cart_uuid,
        scheduledTime: parsed.data.deliveryAt,
        includeWorkBenefits: true,
        intent,
      });
      if (!preview.ok) return err(`doordash_preview_failed:${preview.error}`);
      if (!preview.value.success || !preview.value.quote) {
        return err(`doordash_preview_unavailable:${preview.value.message ?? 'unknown'}`);
      }
      return ok({
        previewOnly: true,
        cartUuid: added.value.cart_uuid,
        restaurant: parsed.data.restaurant,
        deliveryAddress: parsed.data.deliveryAddress,
        deliveryAt: parsed.data.deliveryAt ?? null,
        quote: preview.value.quote,
      });
    }

    case 'schedule_reminder': {
      const parsed = scheduleReminderPayloadSchema.safeParse(action.payload);
      if (!parsed.success) return err('invalid_reminder_payload');
      if (!parsed.data.artifactId) return err('reminder_artifact_missing');
      const fireAt = new Date(parsed.data.fireAt);
      if (Number.isNaN(fireAt.getTime())) return err('invalid_reminder_time');
      const artifact = await setArtifactStatus(
        db,
        parsed.data.artifactId,
        action.workspaceId,
        'scheduled',
        { fireAt },
      );
      if (!artifact) return err('reminder_artifact_not_found');
      if (emitReminder) {
        await emitReminder({
          artifactId: artifact.id,
          workspaceId: action.workspaceId,
          fireAt,
        });
      } else {
        await inngest.send({
          name: EVENT_NAME_AGENT_REMINDER_DUE,
          ts: fireAt.getTime(),
          data: {
            artifactId: artifact.id,
            workspaceId: action.workspaceId,
          },
        });
      }
      return ok({
        scheduled: true,
        title: parsed.data.title,
        fireAt: parsed.data.fireAt,
        artifactId: artifact.id,
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
  if (kind === 'doordash_order_preview') return formatDoorDashPreview(result);
  if (kind === 'schedule_reminder') {
    return `Reminder scheduled for ${String(result.fireAt ?? 'the requested time')}. I will DM you once.`;
  }
  if (kind.startsWith('sandbox_')) {
    const id = result.mockOrderId ?? result.mockPlanId;
    return `Sandbox execution complete. Reference: \`${String(id)}\`. No vendor was contacted and no money was spent.`;
  }
  return 'The approved workspace setting was updated.';
};

const formatDoorDashPreview = (result: Record<string, unknown>): string => {
  const quote = asRecord(result.quote);
  const total = asRecord(quote?.net_total_before_tip)?.display_string;
  const restaurant = typeof result.restaurant === 'string' ? result.restaurant : 'DoorDash';
  const lines = [
    `Preview ready for ${restaurant}.`,
    `Total before tip: ${typeof total === 'string' ? total : 'see DoorDash quote'}.`,
  ];
  const breakdown = Array.isArray(quote?.line_items)
    ? quote.line_items
        .map((entry) => {
          const row = asRecord(entry);
          const amount = asRecord(row?.final_money)?.display_string;
          return typeof row?.label === 'string' && typeof amount === 'string'
            ? `${row.label}: ${amount}`
            : null;
        })
        .filter((entry): entry is string => entry !== null)
        .slice(0, 8)
    : [];
  if (breakdown.length > 0) lines.push(`Quote: ${breakdown.join('; ')}.`);
  if (typeof result.deliveryAt === 'string')
    lines.push(`Requested delivery: ${result.deliveryAt}.`);
  if (typeof result.deliveryAddress === 'string') {
    lines.push(`Delivery address: ${result.deliveryAddress}.`);
  }
  if (JSON.stringify(quote?.dropoff_options ?? []).includes('"PIN_CODE"')) {
    lines.push(
      'PIN handoff required: retrieve the PIN from DoorDash tracking and give it to the Dasher.',
    );
  }
  const benefits = asRecord(quote?.expense_order_options);
  const eligibleBudgets = Array.isArray(benefits?.all_eligible_expense_order_budgets)
    ? benefits.all_eligible_expense_order_budgets
        .map((entry) => {
          const budget = asRecord(entry);
          const remaining = asRecord(budget?.remaining_amount);
          return typeof budget?.name === 'string' &&
            typeof remaining?.unit_amount === 'number' &&
            remaining.unit_amount > 0 &&
            typeof remaining.display_string === 'string'
            ? `${budget.name} (${remaining.display_string} remaining)`
            : null;
        })
        .filter((entry): entry is string => entry !== null)
    : [];
  if (eligibleBudgets.length > 0) {
    lines.push(`Eligible work benefits: ${eligibleBudgets.join(', ')}. None were applied.`);
  }
  lines.push('No order was submitted and no payment method was charged.');
  return lines.join('\n');
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

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
      return runAgentAction({
        db,
        getSlackClient,
        doorDash: env.DOORDASH_EXECUTOR === 'dd-cli' ? createDdCliClient() : undefined,
        actionId: data.actionId as string,
      });
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true, ...result.value };
  },
);
