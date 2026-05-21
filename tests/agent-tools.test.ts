import { describe, expect, it } from 'vitest';
import {
  getPersonProfileInputSchema,
  listRecentGesturesInputSchema,
  type ProposeSuggestionsInput,
  proposeSuggestionsInputSchema,
  validateProposeBusinessRules,
} from '@/agent/tools';

const validSuggestion = (
  overrides: Partial<ProposeSuggestionsInput['suggestions'][number]> = {},
) => ({
  summary: 'Card from the team',
  details: 'A team-signed card delivered on the day.',
  estimated_cost_cents: 1500,
  rationale: 'Reliable and warm.',
  ...overrides,
});

describe('proposeSuggestionsInputSchema (Zod)', () => {
  it('accepts a valid 2-suggestion payload', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [validSuggestion(), validSuggestion({ summary: 'Surprise cake' })],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a valid 3-suggestion payload', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [
        validSuggestion({ summary: 'A' }),
        validSuggestion({ summary: 'B' }),
        validSuggestion({ summary: 'C' }),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects fewer than 2 suggestions', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [validSuggestion()],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects more than 3 suggestions', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [
        validSuggestion({ summary: 'A' }),
        validSuggestion({ summary: 'B' }),
        validSuggestion({ summary: 'C' }),
        validSuggestion({ summary: 'D' }),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty summary', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [validSuggestion({ summary: '' }), validSuggestion()],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects summary over 80 chars', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [validSuggestion({ summary: 'x'.repeat(81) }), validSuggestion()],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts cost of 0 (free gestures)', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [
        validSuggestion({ summary: 'Free thing', estimated_cost_cents: 0 }),
        validSuggestion(),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects negative cost', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [validSuggestion({ estimated_cost_cents: -1 }), validSuggestion()],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-integer cost', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [validSuggestion({ estimated_cost_cents: 12.5 }), validSuggestion()],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [
        { summary: 'X', details: 'Y', estimated_cost_cents: 100 } /* no rationale */,
        validSuggestion(),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects rationale over 280 chars', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [validSuggestion({ rationale: 'r'.repeat(281) }), validSuggestion()],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts rationale at the 280-char boundary', () => {
    const parsed = proposeSuggestionsInputSchema.safeParse({
      suggestions: [validSuggestion({ rationale: 'r'.repeat(280) }), validSuggestion()],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('validateProposeBusinessRules', () => {
  it('returns no errors for in-budget, distinct suggestions', () => {
    const errors = validateProposeBusinessRules(
      {
        suggestions: [
          validSuggestion({ summary: 'A', estimated_cost_cents: 1000 }),
          validSuggestion({ summary: 'B', estimated_cost_cents: 2000 }),
        ],
      },
      5000,
    );
    expect(errors).toEqual([]);
  });

  it('flags over-budget suggestions with the right field path', () => {
    const errors = validateProposeBusinessRules(
      {
        suggestions: [
          validSuggestion({ summary: 'A', estimated_cost_cents: 1000 }),
          validSuggestion({ summary: 'B', estimated_cost_cents: 6000 }),
        ],
      },
      5000,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('suggestions[1].estimated_cost_cents');
    expect(errors[0]?.message).toContain('5000');
  });

  it('flags suggestions exactly at-budget as allowed (boundary)', () => {
    const errors = validateProposeBusinessRules(
      {
        suggestions: [
          validSuggestion({ summary: 'A', estimated_cost_cents: 5000 }),
          validSuggestion({ summary: 'B', estimated_cost_cents: 5000 }),
        ],
      },
      5000,
    );
    // No budget errors; one duplicate error though (same summary).
    expect(errors.some((e) => e.field.includes('estimated_cost_cents'))).toBe(false);
  });

  it('flags duplicate summaries (case + whitespace insensitive)', () => {
    const errors = validateProposeBusinessRules(
      {
        suggestions: [
          validSuggestion({ summary: 'Surprise Cake' }),
          validSuggestion({ summary: '  surprise cake  ' }),
        ],
      },
      5000,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('suggestions[1].summary');
    expect(errors[0]?.message).toContain('Duplicate');
  });

  it('reports both over-budget AND duplicate-summary errors when both present', () => {
    const errors = validateProposeBusinessRules(
      {
        suggestions: [
          validSuggestion({ summary: 'A', estimated_cost_cents: 9000 }),
          validSuggestion({ summary: 'a', estimated_cost_cents: 10000 }),
        ],
      },
      5000,
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('listRecentGesturesInputSchema', () => {
  it('accepts empty input (no limit)', () => {
    expect(listRecentGesturesInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a valid limit', () => {
    expect(listRecentGesturesInputSchema.safeParse({ limit: 5 }).success).toBe(true);
  });

  it('rejects limit > 25', () => {
    expect(listRecentGesturesInputSchema.safeParse({ limit: 100 }).success).toBe(false);
  });

  it('rejects limit < 1', () => {
    expect(listRecentGesturesInputSchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('getPersonProfileInputSchema', () => {
  it('accepts empty input', () => {
    expect(getPersonProfileInputSchema.safeParse({}).success).toBe(true);
  });
});
