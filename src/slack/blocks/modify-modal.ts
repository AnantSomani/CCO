import {
  BLOCK_MODIFY_BUDGET,
  BLOCK_MODIFY_GESTURE,
  CALLBACK_MODIFY_GESTURE,
  INPUT_BUDGET,
  INPUT_GESTURE,
} from '@/slack/ids';

type Person = { name: string };
type Event = { id: string; kind: 'birthday' | 'anniversary'; years: number | null };
type Suggestion = { gestureSummary: string; estimatedCostCents: number };

export type ModifyModalInput = {
  event: Event;
  person: Person;
  suggestions: Suggestion[];
  // Carries routing data (eventId + approval DM channel/ts) so the submit
  // handler can chat.update the original DM. Slack caps this at 3000 chars;
  // our JSON payload is well under that.
  privateMetadata: string;
  // Optional starting values for the inputs. The default budget feeds the
  // number_input's initial_value so admins don't have to retype it.
  defaultBudgetCents: number;
};

// Slack's number_input rejects trailing zeros (`"50.00"` → invalid_arguments).
// Use Number's default toString so 5000 → "50" and 4250 → "42.5".
const formatUsdInput = (cents: number): string => (Math.round(cents) / 100).toString();

export const buildModifyModal = ({
  event,
  person,
  suggestions,
  privateMetadata,
  defaultBudgetCents,
}: ModifyModalInput): unknown => {
  // Pre-fill the gesture input with the top-ranked suggestion's summary so the
  // admin can lightly edit instead of writing from scratch.
  const initialGesture = suggestions[0]?.gestureSummary ?? '';
  const subtitle =
    event.kind === 'birthday'
      ? `Birthday for ${person.name}`
      : `${event.years ?? 0}-year anniversary for ${person.name}`;

  return {
    type: 'modal',
    callback_id: CALLBACK_MODIFY_GESTURE,
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: 'Modify gesture' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: subtitle }],
      },
      {
        type: 'input',
        block_id: BLOCK_MODIFY_GESTURE,
        label: { type: 'plain_text', text: 'Gesture' },
        element: {
          type: 'plain_text_input',
          action_id: INPUT_GESTURE,
          multiline: true,
          initial_value: initialGesture,
          max_length: 500,
        },
      },
      {
        type: 'input',
        block_id: BLOCK_MODIFY_BUDGET,
        label: { type: 'plain_text', text: 'Budget (USD)' },
        element: {
          type: 'number_input',
          action_id: INPUT_BUDGET,
          is_decimal_allowed: true,
          initial_value: formatUsdInput(defaultBudgetCents),
          min_value: '0',
        },
      },
    ],
  };
};
