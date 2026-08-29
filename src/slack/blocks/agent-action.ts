import {
  type AgentActionKind,
  type AgentActionStatus,
  doorDashOrderPreviewPayloadSchema,
  sandboxEventPlanPayloadSchema,
  sandboxFoodOrderPayloadSchema,
  scheduleReminderPayloadSchema,
  setCelebrationChannelPayloadSchema,
  setDefaultBudgetPayloadSchema,
} from '@/agent/command-types';
import {
  ACTION_APPROVE_AGENT_ACTION,
  ACTION_CANCEL_AGENT_ACTION,
  ACTION_REJECT_AGENT_ACTION,
} from '@/slack/ids';

type PendingAgentActionInput = {
  id: string;
  kind: AgentActionKind;
  summary: string;
  payload: unknown;
  estimatedCostCents: number | null;
};

const kindLabel = (kind: AgentActionKind): string => {
  switch (kind) {
    case 'set_default_budget':
      return 'Workspace setting';
    case 'set_celebration_channel':
      return 'Workspace setting';
    case 'sandbox_food_order':
      return 'Sandbox food order';
    case 'doordash_order_preview':
      return 'DoorDash order preview';
    case 'sandbox_event_plan':
      return 'Sandbox event plan';
    case 'schedule_reminder':
      return 'Reminder';
  }
};

export const buildAgentActionConfirmation = (
  action: PendingAgentActionInput,
): { text: string; blocks: unknown[] } => {
  const cost =
    action.estimatedCostCents === null
      ? ''
      : `\n*Estimated cost:* $${(action.estimatedCostCents / 100).toFixed(2)}`;
  const sandbox = action.kind.startsWith('sandbox_')
    ? '\n:warning: *Sandbox only:* no vendor will be contacted and no money will be spent.'
    : '';
  const previewOnly =
    action.kind === 'doordash_order_preview'
      ? '\n:warning: *Preview only:* approval may set the delivery address on the connected DoorDash account, create or change a cart, and retrieve a live quote. It cannot submit an order or charge a payment method.'
      : '';
  const safeSummary = escapeMrkdwn(action.summary);
  const text = `Approval required: ${action.summary}`;
  const details = formatActionDetails(action.kind, action.payload);

  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${kindLabel(action.kind)}*\n${safeSummary}\n${details}${cost}${sandbox}${previewOnly}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: ACTION_APPROVE_AGENT_ACTION,
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            value: JSON.stringify({ actionId: action.id }),
          },
          {
            type: 'button',
            action_id: ACTION_REJECT_AGENT_ACTION,
            text: { type: 'plain_text', text: 'Reject' },
            style: 'danger',
            value: JSON.stringify({ actionId: action.id }),
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Confetti will not execute this action until an authorized admin approves it.',
          },
        ],
      },
    ],
  };
};

const formatActionDetails = (kind: AgentActionKind, payload: unknown): string => {
  switch (kind) {
    case 'set_default_budget': {
      const parsed = setDefaultBudgetPayloadSchema.safeParse(payload);
      return parsed.success
        ? `*New default:* $${(parsed.data.amountCents / 100).toFixed(2)}`
        : 'Invalid budget payload';
    }
    case 'set_celebration_channel': {
      const parsed = setCelebrationChannelPayloadSchema.safeParse(payload);
      return parsed.success
        ? `*New channel:* <#${parsed.data.channelId}>`
        : 'Invalid channel payload';
    }
    case 'sandbox_food_order': {
      const parsed = sandboxFoodOrderPayloadSchema.safeParse(payload);
      if (!parsed.success) return 'Invalid sandbox order payload';
      return [
        `*Restaurant:* ${escapeMrkdwn(parsed.data.restaurant)}`,
        `*Items:* ${escapeMrkdwn(parsed.data.itemsDescription)}`,
        `*Headcount:* ${parsed.data.headcount}`,
        `*Delivery:* ${escapeMrkdwn(parsed.data.deliveryAt)}`,
        `*Address:* ${escapeMrkdwn(parsed.data.deliveryAddress)}`,
      ].join('\n');
    }
    case 'doordash_order_preview': {
      const parsed = doorDashOrderPreviewPayloadSchema.safeParse(payload);
      if (!parsed.success) return 'Invalid DoorDash preview payload';
      return [
        `*Restaurant:* ${escapeMrkdwn(parsed.data.restaurant)}`,
        `*Items:* ${parsed.data.items
          .map((item) => {
            const options = (item.nestedOptions ?? [])
              .map((option) => (typeof option.name === 'string' ? option.name : null))
              .filter((name): name is string => Boolean(name));
            const suffix = options.length > 0 ? ` (${escapeMrkdwn(options.join(', '))})` : '';
            return `${item.quantity}× ${escapeMrkdwn(item.itemName)}${suffix}`;
          })
          .join(', ')}`,
        `*Delivery:* ${escapeMrkdwn(parsed.data.deliveryAt ?? 'ASAP')}`,
        `*Delivery address:* ${escapeMrkdwn(parsed.data.deliveryAddress)}`,
      ].join('\n');
    }
    case 'sandbox_event_plan': {
      const parsed = sandboxEventPlanPayloadSchema.safeParse(payload);
      if (!parsed.success) return 'Invalid sandbox event payload';
      return [
        `*Event:* ${escapeMrkdwn(parsed.data.title)}`,
        `*When:* ${escapeMrkdwn(parsed.data.eventAt)}`,
        `*Location:* ${escapeMrkdwn(parsed.data.location)}`,
        `*Headcount:* ${parsed.data.headcount}`,
        `*Agenda:* ${escapeMrkdwn(parsed.data.agenda)}`,
      ].join('\n');
    }
    case 'schedule_reminder': {
      const parsed = scheduleReminderPayloadSchema.safeParse(payload);
      if (!parsed.success) return 'Invalid reminder payload';
      return [
        `*Title:* ${escapeMrkdwn(parsed.data.title)}`,
        `*When:* ${escapeMrkdwn(parsed.data.fireAt)}`,
        parsed.data.note ? `*Note:* ${escapeMrkdwn(parsed.data.note)}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n');
    }
  }
};

export const buildAgentActionResolved = (input: {
  actionId?: string;
  kind?: AgentActionKind;
  summary: string;
  status: AgentActionStatus;
  detail?: string;
}): { text: string; blocks: unknown[] } => {
  const statusLabel: Record<AgentActionStatus, string> = {
    pending_confirmation: 'Pending confirmation',
    approved: 'Approved and queued',
    executing: 'Executing',
    completed: 'Completed',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    failed: 'Failed',
  };
  const text = `${statusLabel[input.status]}: ${input.summary}`;
  const safeSummary = escapeMrkdwn(input.summary);
  const safeDetail = input.detail ? escapeMrkdwn(input.detail) : null;
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${statusLabel[input.status]}*\n${safeSummary}${safeDetail ? `\n${safeDetail}` : ''}`,
      },
    },
  ];
  if (input.status === 'completed' && input.kind?.startsWith('sandbox_') && input.actionId) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: ACTION_CANCEL_AGENT_ACTION,
          text: { type: 'plain_text', text: 'Cancel sandbox action' },
          value: JSON.stringify({ actionId: input.actionId }),
        },
      ],
    });
  }
  return {
    text,
    blocks,
  };
};

const escapeMrkdwn = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
