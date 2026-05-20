import { describe, expect, it } from 'vitest';
import { buildModifyModal } from '@/slack/blocks/modify-modal';
import { BLOCK_MODIFY_BUDGET, BLOCK_MODIFY_GESTURE, CALLBACK_MODIFY_GESTURE } from '@/slack/ids';

const birthdayEvent = { id: 'evt_b', kind: 'birthday' as const, years: null };
const person = { name: 'Alice Park' };
const suggestions = [
  { gestureSummary: 'Card from team + $30 gift card', estimatedCostCents: 4500 },
];

describe('buildModifyModal', () => {
  it('builds a modal with callback_id, private_metadata, gesture + budget inputs', () => {
    const view = buildModifyModal({
      event: birthdayEvent,
      person,
      suggestions,
      privateMetadata: JSON.stringify({ eventId: 'evt_b', channel: 'D1', ts: '111.222' }),
      defaultBudgetCents: 5000,
    }) as {
      type: string;
      callback_id: string;
      private_metadata: string;
      blocks: Array<{ type: string; block_id?: string }>;
    };
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(CALLBACK_MODIFY_GESTURE);
    expect(JSON.parse(view.private_metadata)).toEqual({
      eventId: 'evt_b',
      channel: 'D1',
      ts: '111.222',
    });
    const blockIds = view.blocks.map((b) => b.block_id).filter(Boolean);
    expect(blockIds).toContain(BLOCK_MODIFY_GESTURE);
    expect(blockIds).toContain(BLOCK_MODIFY_BUDGET);
    expect(view).toMatchSnapshot();
  });

  it('pre-fills gesture input with top suggestion summary', () => {
    const view = buildModifyModal({
      event: birthdayEvent,
      person,
      suggestions,
      privateMetadata: 'x',
      defaultBudgetCents: 5000,
    }) as {
      blocks: Array<{ block_id?: string; element?: { initial_value?: string } }>;
    };
    const gestureBlock = view.blocks.find((b) => b.block_id === BLOCK_MODIFY_GESTURE);
    expect(gestureBlock?.element?.initial_value).toBe('Card from team + $30 gift card');
  });

  it('renders default budget cents as decimal USD initial_value', () => {
    const view = buildModifyModal({
      event: birthdayEvent,
      person,
      suggestions,
      privateMetadata: 'x',
      defaultBudgetCents: 4250,
    }) as {
      blocks: Array<{ block_id?: string; element?: { initial_value?: string } }>;
    };
    const budgetBlock = view.blocks.find((b) => b.block_id === BLOCK_MODIFY_BUDGET);
    // Slack rejects trailing zeros on number_input initial_value.
    expect(budgetBlock?.element?.initial_value).toBe('42.5');
  });

  it('renders whole-dollar budgets without a decimal point', () => {
    const view = buildModifyModal({
      event: birthdayEvent,
      person,
      suggestions,
      privateMetadata: 'x',
      defaultBudgetCents: 5000,
    }) as {
      blocks: Array<{ block_id?: string; element?: { initial_value?: string } }>;
    };
    const budgetBlock = view.blocks.find((b) => b.block_id === BLOCK_MODIFY_BUDGET);
    expect(budgetBlock?.element?.initial_value).toBe('50');
  });
});
