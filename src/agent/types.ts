import type { NewSuggestionInput } from '@/db/queries/suggestions';

// Agent-specific shapes — trimmed projections of the DB types. Keeping the
// agent's input surface minimal so tests don't need to construct full Person /
// Workspace objects.

export type AgentEvent = {
  kind: 'birthday' | 'anniversary';
  years: number | null;
};

export type AgentPerson = {
  name: string;
  role: string | null;
  team: string | null;
  slackUserId: string | null;
  startDate: string | null; // YYYY-MM-DD; used to compute tenure
};

export type AgentWorkspace = {
  id: string;
  defaultBudgetCents: number;
  teamName: string;
};

export type AgentToolCall = {
  name: string;
  input: Record<string, unknown>;
};

// Discriminated result.
//   ok: false  — precondition violations we can't recover from (e.g. budget ≤ 0)
//   ok: true   — always carries ≥ 1 suggestion; `usedFallback: true` when the
//                loop bailed to the safe single-suggestion fallback.
// Per spec: the pipeline must never leave an event with zero suggestions.
export type AgentResult =
  | {
      ok: true;
      suggestions: NewSuggestionInput[];
      usedFallback: boolean;
      rounds: number;
      toolCalls: AgentToolCall[];
      error?: string;
    }
  | { ok: false; error: string };
