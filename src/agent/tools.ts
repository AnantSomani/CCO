import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// Three tools. Each is defined with both its Anthropic JSON Schema and a Zod
// parser for the model's argument. Update both sides if you change one.

// ─── tool name constants ─────────────────────────────────────────────────────

export const TOOL_GET_PERSON_PROFILE = 'get_person_profile' as const;
export const TOOL_LIST_RECENT_GESTURES = 'list_recent_workspace_gestures' as const;
export const TOOL_PROPOSE_SUGGESTIONS = 'propose_suggestions' as const;

// ─── propose_suggestions ─────────────────────────────────────────────────────
// Terminal output tool. Calling it commits the agent's final suggestions and
// ends the loop. Validated in two passes:
//   1. Zod parse (structure: types, lengths, required fields)
//   2. Business rules (budget cap, no duplicate summaries) — see
//      validateProposeBusinessRules below
// Both layers surface specific error messages back to the model on the retry
// round so it can correct.

export const proposeSuggestionsInputSchema = z.object({
  suggestions: z
    .array(
      z.object({
        summary: z.string().min(1).max(80),
        details: z.string().min(1).max(500),
        // Zero is allowed — some great gestures cost nothing (signed Slack
        // thread, time off, team playlist). Forcing > 0 made the model retry
        // with `1` to work around it.
        estimated_cost_cents: z.number().int().nonnegative(),
        // Bumped from 200 → 280 after CP3 tuning: model was wasting a round on
        // length-cap retries when its first-pass rationale ran ~210-220 chars.
        rationale: z.string().min(1).max(280),
      }),
    )
    .min(2)
    .max(3),
});

export type ProposeSuggestionsInput = z.infer<typeof proposeSuggestionsInputSchema>;

// ─── get_person_profile ──────────────────────────────────────────────────────
// No arguments — operates on the current event's person via closure context.
// The model just signals "I want extra context."

export const getPersonProfileInputSchema = z.object({});
export type GetPersonProfileInput = z.infer<typeof getPersonProfileInputSchema>;

// ─── list_recent_workspace_gestures ──────────────────────────────────────────

export const listRecentGesturesInputSchema = z.object({
  limit: z.number().int().min(1).max(25).optional(),
});

export type ListRecentGesturesInput = z.infer<typeof listRecentGesturesInputSchema>;

// ─── Anthropic tool definitions ──────────────────────────────────────────────

export const ANTHROPIC_TOOLS: Anthropic.Tool[] = [
  {
    name: TOOL_GET_PERSON_PROFILE,
    description:
      'Fetch extended profile fields for the person being celebrated (name, role, team, tenure_days, slack_user_id). Call this when you want more context before proposing.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: TOOL_LIST_RECENT_GESTURES,
    description:
      "List recently approved gestures from this workspace so you don't repeat them and can read the room.",
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'integer',
          description: 'How many recent gestures to fetch. Defaults to 10. Max 25.',
          minimum: 1,
          maximum: 25,
        },
      },
    },
  },
  {
    name: TOOL_PROPOSE_SUGGESTIONS,
    description:
      'Commit your final 2 or 3 suggestions for this event. Calling this tool ends the loop. Each suggestion needs a summary, details, estimated_cost_cents within budget, and a rationale tied to this specific person and moment.',
    input_schema: {
      type: 'object' as const,
      properties: {
        suggestions: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                maxLength: 80,
                description: 'Short, human-friendly name for the gesture.',
              },
              details: {
                type: 'string',
                maxLength: 500,
                description: '1–2 sentences describing what this concretely is.',
              },
              estimated_cost_cents: {
                type: 'integer',
                minimum: 0,
                description:
                  'Estimated cost in cents. Must be within the workspace budget. Use 0 for gestures with no out-of-pocket cost (e.g. a signed Slack thread, a half-day off, a team-curated playlist).',
              },
              rationale: {
                type: 'string',
                maxLength: 280,
                description: 'Why this specific person and moment. Keep it brief — 1-2 sentences.',
              },
            },
            required: ['summary', 'details', 'estimated_cost_cents', 'rationale'],
          },
        },
      },
      required: ['suggestions'],
    },
  },
];

// Used on the force-terminal round: tools array carries only propose, and
// tool_choice forces it.
export const PROPOSE_SUGGESTIONS_TOOL: Anthropic.Tool = ANTHROPIC_TOOLS.find(
  (t) => t.name === TOOL_PROPOSE_SUGGESTIONS,
) as Anthropic.Tool;

// ─── business-rule validation (after Zod) ────────────────────────────────────

export type ProposeValidationError = { field: string; message: string };

export const validateProposeBusinessRules = (
  input: ProposeSuggestionsInput,
  budgetCents: number,
): ProposeValidationError[] => {
  const errors: ProposeValidationError[] = [];

  for (let i = 0; i < input.suggestions.length; i++) {
    const s = input.suggestions[i];
    if (!s) continue;
    if (s.estimated_cost_cents > budgetCents) {
      errors.push({
        field: `suggestions[${i}].estimated_cost_cents`,
        message: `${s.estimated_cost_cents} exceeds workspace budget of ${budgetCents} cents.`,
      });
    }
  }

  // No two suggestions with identical summaries (case-insensitive, whitespace
  // trimmed). Fixes the "three subtly different cake ideas" failure mode.
  const seen = new Map<string, number>();
  for (let i = 0; i < input.suggestions.length; i++) {
    const s = input.suggestions[i];
    if (!s) continue;
    const key = s.summary.trim().toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) {
      errors.push({
        field: `suggestions[${i}].summary`,
        message: `Duplicate of suggestions[${prev}].summary. Each suggestion needs a distinct summary.`,
      });
    } else {
      seen.set(key, i);
    }
  }

  return errors;
};

// Helper for the loop: render Zod parse issues into a single string suitable
// for a tool_result error message.
export const formatZodIssues = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
