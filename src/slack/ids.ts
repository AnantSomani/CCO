// Slack action_id / callback_id / command constants and Inngest event names.
// Handlers reference these instead of inline string literals so renames are
// safe and grep-friendly.

// ─── slash command ───────────────────────────────────────────────────────────
export const COMMAND_CONFETTI = '/confetti' as const;
export const SUBCOMMAND_HELLO = 'hello' as const;
export const SUBCOMMAND_CHANNEL = 'channel' as const;
export const SUBCOMMAND_BUDGET = 'budget' as const;
export const SUBCOMMAND_OPT_OUTS = 'opt-outs' as const;
export const SUBCOMMAND_HELP = 'help' as const;

// ─── interactivity action_ids (block_actions buttons) ────────────────────────
export const ACTION_APPROVE_EVENT = 'approve_event' as const;
export const ACTION_MODIFY_EVENT = 'modify_event' as const;
export const ACTION_SKIP_EVENT = 'skip_event' as const;
export const ACTION_APPROVE_AGENT_ACTION = 'approve_agent_action' as const;
export const ACTION_REJECT_AGENT_ACTION = 'reject_agent_action' as const;
export const ACTION_CANCEL_AGENT_ACTION = 'cancel_agent_action' as const;

// ─── view callback + block/input ids (modify modal) ──────────────────────────
export const CALLBACK_MODIFY_GESTURE = 'modify_gesture' as const;
export const BLOCK_MODIFY_GESTURE = 'modify_gesture_block' as const;
export const BLOCK_MODIFY_BUDGET = 'modify_budget_block' as const;
export const INPUT_GESTURE = 'gesture_input' as const;
export const INPUT_BUDGET = 'budget_input' as const;

// ─── Inngest event names ─────────────────────────────────────────────────────
// Daily scan emits one of these per newly-created event.
export const EVENT_NAME_EVENT_CREATED = 'confetti/event.created' as const;
// Approve / modify handlers schedule one of these with `ts` = delivery time.
export const EVENT_NAME_DAY_OF_SCHEDULED = 'confetti/day-of.scheduled' as const;
export const EVENT_NAME_AGENT_COMMAND_REQUESTED = 'confetti/agent-command.requested' as const;
export const EVENT_NAME_AGENT_ACTION_APPROVED = 'confetti/agent-action.approved' as const;
