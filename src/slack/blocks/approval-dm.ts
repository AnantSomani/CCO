import { ACTION_APPROVE_EVENT, ACTION_MODIFY_EVENT, ACTION_SKIP_EVENT } from '@/slack/ids';

// Approval DM sent to the workspace admin when an event's suggestions are
// ready. The fallback `text` is required by Slack for notifications and
// accessibility — blocks alone don't satisfy that contract.
//
// Button `value` is a JSON-encoded payload of routing info the action handler
// reads back. Approve carries the chosen suggestion id; modify/skip carry just
// the event id.

type Person = { name: string; role: string | null; team: string | null };
type Event = { id: string; kind: 'birthday' | 'anniversary'; years: number | null };
type Suggestion = { id: string; gestureSummary: string; estimatedCostCents: number };

export type ApprovalDmInput = {
  event: Event;
  person: Person;
  suggestions: Suggestion[];
};

export type BuiltMessage = { blocks: unknown[]; text: string };

const formatUsd = (cents: number): string => `$${Math.round(cents / 100)}`;

const headerText = (event: Event, person: Person): string => {
  if (event.kind === 'birthday') {
    return `🎂 ${person.name}'s birthday is in 7 days`;
  }
  const years = event.years ?? 0;
  return `🎉 ${person.name}'s ${years}-year anniversary is in 14 days`;
};

const contextText = (person: Person): string | null => {
  const parts: string[] = [];
  if (person.role) parts.push(person.role);
  if (person.team) parts.push(person.team);
  return parts.length ? parts.join(' · ') : null;
};

export const buildApprovalDM = ({ event, person, suggestions }: ApprovalDmInput): BuiltMessage => {
  const header = headerText(event, person);
  const ctx = contextText(person);

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: header },
    },
  ];

  if (ctx) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ctx }],
    });
  }

  for (const s of suggestions) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `• *${s.gestureSummary}*  _${formatUsd(s.estimatedCostCents)}_`,
      },
    });
  }

  // Use the first suggestion as the default Approve target. Modify/skip don't
  // carry a suggestion id.
  const defaultSuggestion = suggestions[0];
  const approveValue = JSON.stringify({
    eventId: event.id,
    suggestionId: defaultSuggestion?.id ?? null,
  });
  const eventOnlyValue = JSON.stringify({ eventId: event.id });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: ACTION_APPROVE_EVENT,
        style: 'primary',
        text: { type: 'plain_text', text: 'Approve' },
        value: approveValue,
      },
      {
        type: 'button',
        action_id: ACTION_MODIFY_EVENT,
        text: { type: 'plain_text', text: 'Modify' },
        value: eventOnlyValue,
      },
      {
        type: 'button',
        action_id: ACTION_SKIP_EVENT,
        style: 'danger',
        text: { type: 'plain_text', text: 'Skip' },
        value: eventOnlyValue,
      },
    ],
  });

  return { blocks, text: header };
};

// Replacement DM used by chat.update after the admin taps a button. Strips the
// action buttons and shows the resolved state — admin sees confirmation, can
// no longer re-approve.
export type ApprovalResolvedInput =
  | { status: 'approved'; gestureSummary: string }
  | { status: 'modified'; customGestureText: string }
  | { status: 'skipped' };

export const buildApprovalResolvedDM = (input: ApprovalResolvedInput): BuiltMessage => {
  let text: string;
  if (input.status === 'approved') text = `✅ Approved — ${input.gestureSummary}`;
  else if (input.status === 'modified')
    text = `✅ Approved (modified) — ${input.customGestureText}`;
  else text = '⏭️ Skipped';

  return {
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
    text,
  };
};
