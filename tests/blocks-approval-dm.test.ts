import { describe, expect, it } from 'vitest';
import { buildApprovalDM, buildApprovalResolvedDM } from '@/slack/blocks/approval-dm';
import { ACTION_APPROVE_EVENT, ACTION_MODIFY_EVENT, ACTION_SKIP_EVENT } from '@/slack/ids';

const birthdayEvent = { id: 'evt_b', kind: 'birthday' as const, years: null };
const anniversaryEvent = { id: 'evt_a', kind: 'anniversary' as const, years: 3 };
const person = { name: 'Alice Park', role: 'Engineer', team: 'Platform' };
const suggestions = [
  { id: 'sug_1', gestureSummary: 'Card from team + $30 gift card', estimatedCostCents: 4500 },
  { id: 'sug_2', gestureSummary: 'Surprise cake at standup', estimatedCostCents: 6500 },
];

describe('buildApprovalDM', () => {
  it('builds a birthday DM with header, context, suggestions and action buttons', () => {
    const built = buildApprovalDM({ event: birthdayEvent, person, suggestions });
    expect(built.text).toBe("🎂 Alice Park's birthday is in 7 days");
    expect(built.blocks).toMatchSnapshot();
  });

  it('builds an anniversary DM with years in the header', () => {
    const built = buildApprovalDM({ event: anniversaryEvent, person, suggestions });
    expect(built.text).toBe("🎉 Alice Park's 3-year anniversary is in 14 days");
    expect(built.blocks).toMatchSnapshot();
  });

  it('embeds eventId + first suggestion id in Approve button, eventId-only in Modify/Skip', () => {
    const built = buildApprovalDM({ event: birthdayEvent, person, suggestions });
    const actions = (built.blocks as Array<Record<string, unknown>>).find(
      (b) => b.type === 'actions',
    );
    const elements = actions?.elements as Array<{ action_id: string; value: string }>;
    const approve = elements.find((e) => e.action_id === ACTION_APPROVE_EVENT);
    const modify = elements.find((e) => e.action_id === ACTION_MODIFY_EVENT);
    const skip = elements.find((e) => e.action_id === ACTION_SKIP_EVENT);
    expect(JSON.parse(approve?.value ?? '{}')).toEqual({ eventId: 'evt_b', suggestionId: 'sug_1' });
    expect(JSON.parse(modify?.value ?? '{}')).toEqual({ eventId: 'evt_b' });
    expect(JSON.parse(skip?.value ?? '{}')).toEqual({ eventId: 'evt_b' });
  });

  it('omits the context block when role and team are both null', () => {
    const built = buildApprovalDM({
      event: birthdayEvent,
      person: { name: 'No Role', role: null, team: null },
      suggestions,
    });
    const types = (built.blocks as Array<{ type: string }>).map((b) => b.type);
    expect(types).not.toContain('context');
  });
});

describe('buildApprovalResolvedDM', () => {
  it('shows the chosen gesture for approved', () => {
    const built = buildApprovalResolvedDM({
      status: 'approved',
      gestureSummary: 'Card from team',
    });
    expect(built.text).toBe('✅ Approved — Card from team');
  });

  it('shows skipped state', () => {
    expect(buildApprovalResolvedDM({ status: 'skipped' }).text).toBe('⏭️ Skipped');
  });

  it('shows custom text for modified', () => {
    const built = buildApprovalResolvedDM({
      status: 'modified',
      customGestureText: 'Send them flowers',
    });
    expect(built.text).toBe('✅ Approved (modified) — Send them flowers');
  });
});
