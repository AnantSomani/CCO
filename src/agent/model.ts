// Loop tuning lives here so it's a one-file diff to swap models or change
// limits. Per ARCHITECTURE.md: Claude Sonnet for the agent.

export const AGENT_MODEL = 'claude-sonnet-4-6' as const;
export const AGENT_MAX_TOKENS = 2048;
export const AGENT_TIMEOUT_MS = 30_000;
export const MAX_ROUNDS = 5;
// On this round and after, the request only carries propose_suggestions and
// tool_choice forces it. The model has to commit.
export const FORCE_TERMINAL_ROUND = 5;
