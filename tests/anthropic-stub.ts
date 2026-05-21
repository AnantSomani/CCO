import type Anthropic from '@anthropic-ai/sdk';
import { ok } from '@/lib/result';
import type { SlackClient } from '@/slack/client';

// Scripted Anthropic client. Each test pre-builds the exact sequence of
// responses the model "would have" returned, and the stub plays them back one
// per `create()` call. Recorded params let tests assert what was sent to the
// model on each round (tools array, tool_choice, conversation contents).
//
// Mirrors the discipline in tests/slack-stub.ts — boundary mocking, no real
// network, deterministic.

export type ScriptedStep =
  | { kind: 'message'; message: Anthropic.Message }
  | { kind: 'throw'; error: Error };

export type ScriptedAnthropic = {
  client: Anthropic;
  calls: Anthropic.MessageCreateParamsNonStreaming[];
  remaining: () => number;
};

export const scriptedAnthropic = (steps: ScriptedStep[]): ScriptedAnthropic => {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let idx = 0;
  const fakeClient = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParamsNonStreaming,
      ): Promise<Anthropic.Message> => {
        // Snapshot params at capture time — the caller mutates the messages
        // array between rounds, so retaining the reference would let later
        // rounds rewrite earlier `calls[i].messages` history.
        calls.push({ ...params, messages: [...params.messages] });
        if (idx >= steps.length) {
          throw new Error(`scripted anthropic: out of steps (call #${idx + 1})`);
        }
        const step = steps[idx];
        idx++;
        if (!step) throw new Error('scripted anthropic: step undefined');
        if (step.kind === 'throw') throw step.error;
        return step.message;
      },
    },
  };
  return {
    client: fakeClient as unknown as Anthropic,
    calls,
    remaining: () => Math.max(0, steps.length - idx),
  };
};

// ─── response builders ──────────────────────────────────────────────────────

// Empty usage object that satisfies the SDK's structural type. The real
// number of tokens doesn't matter for unit tests.
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: null,
} as unknown as Anthropic.Message['usage'];

let _msgCounter = 0;
const nextId = (): string => {
  _msgCounter += 1;
  return `msg_${_msgCounter}`;
};

const COMMON_MSG_FIELDS = {
  type: 'message' as const,
  role: 'assistant' as const,
  model: 'mock-model',
  stop_sequence: null,
  container: null,
  stop_details: null,
  usage: ZERO_USAGE,
} as unknown as Pick<
  Anthropic.Message,
  'type' | 'role' | 'model' | 'stop_sequence' | 'container' | 'usage'
> &
  Record<string, unknown>;

export const messageWithToolUses = (
  uses: Array<{ id: string; name: string; input: unknown }>,
): Anthropic.Message =>
  ({
    ...COMMON_MSG_FIELDS,
    id: nextId(),
    content: uses.map((u) => ({
      type: 'tool_use',
      id: u.id,
      name: u.name,
      input: u.input as object,
    })),
    stop_reason: 'tool_use',
  }) as unknown as Anthropic.Message;

export const messageTextOnly = (text: string): Anthropic.Message =>
  ({
    ...COMMON_MSG_FIELDS,
    id: nextId(),
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
  }) as unknown as Anthropic.Message;

// Convenience: build a single propose_suggestions tool_use response.
export type ProposeSuggestionShape = {
  summary: string;
  details: string;
  estimated_cost_cents: number;
  rationale: string;
};

export const proposeMessage = (
  suggestions: ProposeSuggestionShape[],
  toolUseId = 'tu_propose',
): Anthropic.Message =>
  messageWithToolUses([{ id: toolUseId, name: 'propose_suggestions', input: { suggestions } }]);

// ─── slack client stub for context tool tests ───────────────────────────────

export type StubUsersInfo = (
  slackUserId: string,
) => Promise<ReturnType<SlackClient['usersInfo']> extends Promise<infer R> ? R : never>;

export const stubSlackClient = (overrides?: { usersInfo?: StubUsersInfo }): SlackClient => ({
  postMessage: async () => ok({ ts: 'stub.ts', channel: 'stub' }),
  chatUpdate: async () => ok({ ts: 'stub.ts' }),
  viewsOpen: async () => ok({ viewId: 'stub_view' }),
  conversationsInfo: async (channel) => ok({ id: channel, name: 'stub', is_member: true }),
  usersInfo:
    overrides?.usersInfo ??
    (async (id) =>
      ok({ id, name: null, realName: null, title: null, pronouns: null, timezone: null })),
});
