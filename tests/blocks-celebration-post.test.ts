import { describe, expect, it } from 'vitest';
import { buildCelebrationPost, CARD_THREAD_PROMPT } from '@/slack/blocks/celebration-post';

describe('buildCelebrationPost', () => {
  it('uses @mention when slackUserId is present (birthday)', () => {
    const built = buildCelebrationPost({
      person: { name: 'Alice Park', slackUserId: 'U123' },
      kind: 'birthday',
    });
    expect(built.text).toContain('<@U123>');
    expect(built.text).toMatch(/Happy birthday/);
  });

  it('falls back to first name when slackUserId is null (anniversary)', () => {
    const built = buildCelebrationPost({
      person: { name: 'Alice Park', slackUserId: null },
      kind: 'anniversary',
      years: 3,
    });
    expect(built.text).toMatch(/3 years/);
    expect(built.text).toContain('Alice');
    expect(built.text).not.toContain('<@');
  });

  it('includes the gesture as a context block when customGestureText is provided', () => {
    const built = buildCelebrationPost({
      person: { name: 'Alice Park', slackUserId: 'U1' },
      kind: 'birthday',
      customGestureText: 'Send them flowers',
    });
    const contextBlock = (built.blocks as Array<Record<string, unknown>>).find(
      (b) => b.type === 'context',
    );
    expect(contextBlock).toBeDefined();
    expect(JSON.stringify(contextBlock)).toContain('Send them flowers');
    expect(built.blocks).toMatchSnapshot();
  });

  it('falls back to suggestionSummary when no customGestureText is provided', () => {
    const built = buildCelebrationPost({
      person: { name: 'Alice Park', slackUserId: 'U1' },
      kind: 'birthday',
      suggestionSummary: 'Card from team',
    });
    expect(JSON.stringify(built.blocks)).toContain('Card from team');
  });

  it('omits the gesture context block when neither custom nor suggestion is provided', () => {
    const built = buildCelebrationPost({
      person: { name: 'Alice Park', slackUserId: 'U1' },
      kind: 'birthday',
    });
    const types = (built.blocks as Array<{ type: string }>).map((b) => b.type);
    expect(types).not.toContain('context');
    expect(built.blocks).toMatchSnapshot();
  });
});

describe('CARD_THREAD_PROMPT', () => {
  it('uses the first name', () => {
    expect(CARD_THREAD_PROMPT({ name: 'Alice Park' })).toBe('👇 sign the card for Alice!');
  });
});
