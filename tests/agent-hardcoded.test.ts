import { describe, expect, it } from 'vitest';
import { generateHardcodedSuggestions } from '@/agent/hardcoded';

const workspace = { id: 'ws_1', defaultBudgetCents: 100_00 };
const person = { name: 'Alice Park' };

describe('generateHardcodedSuggestions', () => {
  it('returns exactly 2 birthday suggestions', () => {
    const out = generateHardcodedSuggestions({
      event: { kind: 'birthday', years: null },
      person,
      workspace,
    });
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.rank).sort()).toEqual([1, 2]);
  });

  it('returns exactly 2 anniversary suggestions with first-name substitution', () => {
    const out = generateHardcodedSuggestions({
      event: { kind: 'anniversary', years: 3 },
      person,
      workspace,
    });
    expect(out).toHaveLength(2);
    const summaries = out.map((s) => s.gestureSummary);
    expect(summaries.some((s) => s.includes('Alice'))).toBe(true);
    expect(summaries.every((s) => !s.includes('{person}'))).toBe(true);
  });

  it('clamps suggestion cost to workspace defaultBudgetCents when intended cost exceeds it', () => {
    const tight = { id: 'ws_tight', defaultBudgetCents: 2000 };
    const out = generateHardcodedSuggestions({
      event: { kind: 'birthday', years: null },
      person,
      workspace: tight,
    });
    for (const s of out) {
      expect(s.estimatedCostCents).toBeLessThanOrEqual(2000);
    }
    // Both birthday templates start above $20, so both should be clamped.
    expect(out.every((s) => s.estimatedCostCents === 2000)).toBe(true);
  });

  it('does not clamp when intended cost is within budget', () => {
    const out = generateHardcodedSuggestions({
      event: { kind: 'birthday', years: null },
      person,
      workspace,
    });
    // Card+gift card = 4500, surprise cake = 6500; both under 10000 default.
    expect(out.find((s) => s.rank === 1)?.estimatedCostCents).toBe(4500);
    expect(out.find((s) => s.rank === 2)?.estimatedCostCents).toBe(6500);
  });
});
