import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '@/agent/index';
import { TOOL_LIST_RECENT_GESTURES, TOOL_PROPOSE_SUGGESTIONS } from '@/agent/tools';
import type { AgentEvent, AgentPerson, AgentWorkspace } from '@/agent/types';
import {
  messageTextOnly,
  messageWithToolUses,
  proposeMessage,
  scriptedAnthropic,
} from './anthropic-stub';

const birthday: AgentEvent = { kind: 'birthday', years: null };
const person: AgentPerson = {
  name: 'Alice Park',
  role: 'Eng',
  team: 'Platform',
  slackUserId: 'U123',
  startDate: '2024-01-15',
};
const workspace: AgentWorkspace = {
  id: 'ws_1',
  defaultBudgetCents: 5000,
  teamName: 'Acme',
};

const goodSuggestions = [
  {
    summary: 'Card from the team',
    details: 'A team-signed card delivered on the day.',
    estimated_cost_cents: 1500,
    rationale: 'Reliable and warm.',
  },
  {
    summary: 'Surprise cake at standup',
    details: 'A small cake from the bakery near the office.',
    estimated_cost_cents: 3500,
    rationale: 'Alice always brings treats; return the gesture.',
  },
];

// Silent logger so error/warn paths don't pollute test output.
const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('runAgent — happy paths', () => {
  it('returns suggestions when model calls propose_suggestions directly', async () => {
    const stub = scriptedAnthropic([{ kind: 'message', message: proposeMessage(goodSuggestions) }]);
    const result = await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(false);
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions[0]?.gestureSummary).toBe('Card from the team');
    expect(result.suggestions[0]?.rank).toBe(1);
    expect(result.suggestions[1]?.rank).toBe(2);
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe(TOOL_PROPOSE_SUGGESTIONS);
  });

  it('handles a context-tool call followed by propose_suggestions', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          { id: 'tu_list', name: TOOL_LIST_RECENT_GESTURES, input: { limit: 5 } },
        ]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    const recentRows = [
      { summary: 'Donuts', kind: 'birthday' as const, cost_cents: 1500, decided_at: '2026-04-01' },
    ];

    const result = await runAgent({
      anthropic: stub.client,
      listRecentGestures: async (limit) => recentRows.slice(0, limit),
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(false);
    expect(result.rounds).toBe(2);
    expect(result.toolCalls.map((c) => c.name)).toEqual([
      TOOL_LIST_RECENT_GESTURES,
      TOOL_PROPOSE_SUGGESTIONS,
    ]);

    // Round 2's request should include the recent-gestures tool result in the
    // conversation. Inspect the messages array sent to the model.
    const round2 = stub.calls[1];
    const lastUserMsg = round2?.messages[round2.messages.length - 1];
    expect(lastUserMsg?.role).toBe('user');
    expect(JSON.stringify(lastUserMsg)).toContain('Donuts');
  });

  it('maps tool input fields into the NewSuggestionInput shape', async () => {
    const stub = scriptedAnthropic([{ kind: 'message', message: proposeMessage(goodSuggestions) }]);
    const result = await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.suggestions[0];
    expect(first?.gestureSummary).toBe('Card from the team');
    expect(first?.estimatedCostCents).toBe(1500);
    expect(first?.gestureDetails).toMatchObject({
      source: 'agent',
      kind: 'birthday',
      rank: 1,
      rationale: 'Reliable and warm.',
    });
  });
});

describe('runAgent — validation retry', () => {
  it('retries once after an over-budget propose and accepts a corrected payload', async () => {
    const overBudget = [
      { ...goodSuggestions[0], estimated_cost_cents: 9000 } as (typeof goodSuggestions)[number],
      goodSuggestions[1] as (typeof goodSuggestions)[number],
    ];
    const stub = scriptedAnthropic([
      { kind: 'message', message: proposeMessage(overBudget, 'tu_p1') },
      { kind: 'message', message: proposeMessage(goodSuggestions, 'tu_p2') },
    ]);

    const result = await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(false);
    expect(result.rounds).toBe(2);
    // The validation error from round 1 was surfaced into round 2's conversation.
    const round2Msgs = stub.calls[1]?.messages;
    const last = round2Msgs?.[round2Msgs.length - 1];
    expect(JSON.stringify(last)).toContain('exceeds workspace budget');
  });

  it('falls back when propose_suggestions is invalid twice (after one retry)', async () => {
    const overBudget = (extra = 0) => [
      {
        ...goodSuggestions[0],
        estimated_cost_cents: 9000 + extra,
      } as (typeof goodSuggestions)[number],
      {
        ...goodSuggestions[1],
        estimated_cost_cents: 10000 + extra,
      } as (typeof goodSuggestions)[number],
    ];
    const stub = scriptedAnthropic([
      { kind: 'message', message: proposeMessage(overBudget(0), 'tu_p1') },
      { kind: 'message', message: proposeMessage(overBudget(1), 'tu_p2') },
    ]);

    const result = await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(true);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.gestureSummary).toBe('Card from the team');
    expect(result.error).toContain('validation_failed_after_retry');
    expect(silentLog.error).toHaveBeenCalled();
  });

  it('falls back when propose_suggestions has malformed structure twice', async () => {
    // Only one suggestion (violates min length 2 Zod rule).
    const malformed = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tu_p1',
            name: TOOL_PROPOSE_SUGGESTIONS,
            input: { suggestions: [goodSuggestions[0]] },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tu_p2',
            name: TOOL_PROPOSE_SUGGESTIONS,
            input: { suggestions: [goodSuggestions[1]] },
          },
        ]),
      },
    ]);

    const result = await runAgent({
      anthropic: malformed.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(true);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('runAgent — round cap', () => {
  it('forces propose_suggestions on round 5 (tools array contains only propose, tool_choice forced)', async () => {
    const listMsg = () =>
      messageWithToolUses([
        { id: `tu_${Math.random()}`, name: TOOL_LIST_RECENT_GESTURES, input: {} },
      ]);
    const stub = scriptedAnthropic([
      { kind: 'message', message: listMsg() },
      { kind: 'message', message: listMsg() },
      { kind: 'message', message: listMsg() },
      { kind: 'message', message: listMsg() },
      // Round 5 — model finally complies under forced tool_choice.
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    const result = await runAgent({
      anthropic: stub.client,
      listRecentGestures: async () => [],
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rounds).toBe(5);
    expect(result.usedFallback).toBe(false);

    // Round 5 request: only one tool, choice forced.
    const round5 = stub.calls[4];
    expect(round5?.tools).toHaveLength(1);
    expect(round5?.tools?.[0]?.name).toBe(TOOL_PROPOSE_SUGGESTIONS);
    expect(round5?.tool_choice).toEqual({
      type: 'tool',
      name: TOOL_PROPOSE_SUGGESTIONS,
    });

    // Earlier rounds: full tools array, auto choice.
    const round1 = stub.calls[0];
    expect(round1?.tools?.length).toBeGreaterThan(1);
    expect(round1?.tool_choice).toEqual({ type: 'auto' });
  });

  it('falls back when model never calls propose_suggestions even after force', async () => {
    const listMsg = () =>
      messageWithToolUses([
        { id: `tu_${Math.random()}`, name: TOOL_LIST_RECENT_GESTURES, input: {} },
      ]);
    const stub = scriptedAnthropic([
      { kind: 'message', message: listMsg() },
      { kind: 'message', message: listMsg() },
      { kind: 'message', message: listMsg() },
      { kind: 'message', message: listMsg() },
      // Round 5: model returns text-only instead of complying.
      { kind: 'message', message: messageTextOnly('I refuse.') },
    ]);

    const result = await runAgent({
      anthropic: stub.client,
      listRecentGestures: async () => [],
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(true);
    expect(result.rounds).toBe(5);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('runAgent — defensive parsing', () => {
  it('unwraps suggestions when the model double-encodes the array as a JSON string', async () => {
    // Observed during CP3 tuning: the model occasionally returns
    // `suggestions` as a JSON-encoded string. The loop salvages it before
    // Zod parse so we don't waste a retry round on what's really valid output.
    const stringified = JSON.stringify(goodSuggestions);
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tu_p',
            name: TOOL_PROPOSE_SUGGESTIONS,
            input: { suggestions: stringified },
          },
        ]),
      },
    ]);

    const result = await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(false);
    expect(result.suggestions).toHaveLength(2);
    expect(result.rounds).toBe(1);
  });
});

describe('runAgent — error paths', () => {
  it('falls back when the Anthropic API throws', async () => {
    const stub = scriptedAnthropic([{ kind: 'throw', error: new Error('rate_limit_exceeded') }]);
    const result = await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(true);
    expect(result.error).toContain('api_error');
    expect(result.error).toContain('rate_limit_exceeded');
    expect(silentLog.error).toHaveBeenCalled();
  });

  it('returns ok:false on precondition failure (non-positive budget)', async () => {
    const stub = scriptedAnthropic([]);
    const result = await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace: { ...workspace, defaultBudgetCents: 0 },
      log: silentLog,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('non-positive');
    // Should not have called the API at all.
    expect(stub.calls).toHaveLength(0);
  });
});

describe('runAgent — never zero suggestions invariant', () => {
  it.each([
    ['api error', () => scriptedAnthropic([{ kind: 'throw', error: new Error('boom') }])],
    [
      'force-then-text-only',
      () =>
        scriptedAnthropic([
          { kind: 'message', message: messageTextOnly('hmm') },
          { kind: 'message', message: messageTextOnly('hmm') },
          { kind: 'message', message: messageTextOnly('hmm') },
          { kind: 'message', message: messageTextOnly('hmm') },
          { kind: 'message', message: messageTextOnly('still no') },
        ]),
    ],
    [
      'invalid-twice',
      () =>
        scriptedAnthropic([
          {
            kind: 'message',
            message: messageWithToolUses([
              {
                id: 'tu_1',
                name: TOOL_PROPOSE_SUGGESTIONS,
                input: { suggestions: [] },
              },
            ]),
          },
          {
            kind: 'message',
            message: messageWithToolUses([
              {
                id: 'tu_2',
                name: TOOL_PROPOSE_SUGGESTIONS,
                input: { suggestions: [] },
              },
            ]),
          },
        ]),
    ],
  ])('returns ≥1 suggestion via fallback (%s)', async (_name, makeStub) => {
    const stub = makeStub();
    const result = await runAgent({
      anthropic: stub.client,
      listRecentGestures: async () => [],
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(result.suggestions[0]?.gestureSummary).toBeTruthy();
    expect(result.suggestions[0]?.estimatedCostCents).toBeGreaterThan(0);
  });
});
