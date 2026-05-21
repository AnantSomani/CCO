import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '@/agent/index';
import { TOOL_GET_PERSON_PROFILE, TOOL_LIST_RECENT_GESTURES } from '@/agent/tools';
import type { AgentEvent, AgentPerson, AgentWorkspace } from '@/agent/types';
import { err, ok } from '@/lib/result';
import {
  messageWithToolUses,
  proposeMessage,
  scriptedAnthropic,
  stubSlackClient,
} from './anthropic-stub';

// These tests exercise the context tool dispatch inside runAgent by scripting
// a (context-tool → propose) two-round flow and reading the tool_result that
// was pushed into round 2's conversation. That's how we observe what the
// handlers actually produced.

const birthday: AgentEvent = { kind: 'birthday', years: null };

const person: AgentPerson = {
  name: 'Alice Park',
  role: 'Eng',
  team: 'Platform',
  slackUserId: 'U_ALICE',
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

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => vi.clearAllMocks());

// Helper: extract and JSON-parse the FIRST tool_result block that landed in
// the captured round's conversation. The tool_result.content is itself a
// JSON-stringified payload, so we parse it back to an object for natural
// assertions.
const extractToolResultPayload = (
  calls: { messages: { role: string; content: unknown }[] }[],
  callIndex: number,
): Record<string, unknown> => {
  const round = calls[callIndex];
  if (!round) throw new Error(`no call at index ${callIndex}`);
  const lastUser = round.messages[round.messages.length - 1];
  if (lastUser?.role !== 'user') throw new Error('expected last message to be user');
  if (!Array.isArray(lastUser.content)) throw new Error('expected array content');
  const block = (lastUser.content as Array<{ type: string; content?: unknown }>).find(
    (b) => b.type === 'tool_result',
  );
  if (!block) throw new Error('no tool_result block in last user message');
  if (typeof block.content !== 'string') throw new Error('tool_result content must be string');
  return JSON.parse(block.content) as Record<string, unknown>;
};

describe('get_person_profile', () => {
  it('returns DB-only data when no slackClient is provided', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([{ id: 'tu_p', name: TOOL_GET_PERSON_PROFILE, input: {} }]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    const payload = extractToolResultPayload(stub.calls, 1);
    expect(payload.name).toBe('Alice Park');
    expect(payload.role).toBe('Eng');
    expect(payload.team).toBe('Platform');
    expect(payload.slack_user_id).toBe('U_ALICE');
    expect(payload.tenure_days).toEqual(expect.any(Number));
    expect(payload.slack_title).toBeUndefined();
    expect(payload.slack_pronouns).toBeUndefined();
  });

  it('returns DB-only data + warns when slackClient.usersInfo fails (graceful degradation)', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([{ id: 'tu_p', name: TOOL_GET_PERSON_PROFILE, input: {} }]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    const slackClient = stubSlackClient({
      usersInfo: async () => err('user_not_found'),
    });

    const result = await runAgent({
      anthropic: stub.client,
      slackClient,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(false);

    const payload = extractToolResultPayload(stub.calls, 1);
    expect(payload.name).toBe('Alice Park');
    expect(payload.slack_title).toBeUndefined();

    expect(silentLog.warn).toHaveBeenCalledWith(
      'users.info failed; returning DB-only person profile',
      expect.objectContaining({ error: 'user_not_found' }),
    );
  });

  it('enriches with Slack title and pronouns when usersInfo succeeds', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([{ id: 'tu_p', name: TOOL_GET_PERSON_PROFILE, input: {} }]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    const slackClient = stubSlackClient({
      usersInfo: async (id) =>
        ok({
          id,
          name: 'alice',
          realName: 'Alice Park',
          title: 'Senior Engineer',
          pronouns: 'she/her',
          timezone: 'America/Los_Angeles',
        }),
    });

    await runAgent({
      anthropic: stub.client,
      slackClient,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    const payload = extractToolResultPayload(stub.calls, 1);
    expect(payload.slack_title).toBe('Senior Engineer');
    expect(payload.slack_pronouns).toBe('she/her');
  });

  it('returns tenure_days: null when person has no startDate', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([{ id: 'tu_p', name: TOOL_GET_PERSON_PROFILE, input: {} }]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    await runAgent({
      anthropic: stub.client,
      event: birthday,
      person: { ...person, startDate: null },
      workspace,
      log: silentLog,
    });

    const payload = extractToolResultPayload(stub.calls, 1);
    expect(payload.tenure_days).toBeNull();
  });
});

describe('list_recent_workspace_gestures', () => {
  it('returns provided rows in the tool_result', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          { id: 'tu_l', name: TOOL_LIST_RECENT_GESTURES, input: { limit: 5 } },
        ]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    const rows = [
      {
        summary: 'Donuts',
        kind: 'birthday' as const,
        cost_cents: 1500,
        decided_at: '2026-04-01',
      },
      {
        summary: 'Lunch on the company',
        kind: 'anniversary' as const,
        cost_cents: 4500,
        decided_at: '2026-03-15',
      },
    ];

    await runAgent({
      anthropic: stub.client,
      listRecentGestures: async (_limit) => rows,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    const payload = extractToolResultPayload(stub.calls, 1);
    expect(payload.recent).toEqual(rows);
  });

  it('returns an empty list when no provider is supplied', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([{ id: 'tu_l', name: TOOL_LIST_RECENT_GESTURES, input: {} }]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    const payload = extractToolResultPayload(stub.calls, 1);
    expect(payload.recent).toEqual([]);
  });

  it('passes the requested limit to the provider', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          { id: 'tu_l', name: TOOL_LIST_RECENT_GESTURES, input: { limit: 3 } },
        ]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    const provider = vi.fn(async (_limit: number) => []);
    await runAgent({
      anthropic: stub.client,
      listRecentGestures: provider,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });

    expect(provider).toHaveBeenCalledWith(3);
  });

  it('defaults to limit=10 when the model omits the field', async () => {
    const stub = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([{ id: 'tu_l', name: TOOL_LIST_RECENT_GESTURES, input: {} }]),
      },
      { kind: 'message', message: proposeMessage(goodSuggestions) },
    ]);

    const provider = vi.fn(async (_limit: number) => []);
    await runAgent({
      anthropic: stub.client,
      listRecentGestures: provider,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });
    expect(provider).toHaveBeenCalledWith(10);
  });
});

describe('runAgent — input contract', () => {
  it('includes role, team, slackUserId, budget, workspace name in the first user message', async () => {
    const stub = scriptedAnthropic([{ kind: 'message', message: proposeMessage(goodSuggestions) }]);
    await runAgent({
      anthropic: stub.client,
      event: birthday,
      person,
      workspace,
      log: silentLog,
    });
    const firstUserMsg = stub.calls[0]?.messages[0];
    const text = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : '';
    expect(text).toContain('Alice Park');
    expect(text).toContain('Eng');
    expect(text).toContain('Platform');
    expect(text).toContain('U_ALICE');
    expect(text).toContain('$50.00');
    expect(text).toContain('Acme');
  });

  it('renders anniversary kind with year count', async () => {
    const stub = scriptedAnthropic([{ kind: 'message', message: proposeMessage(goodSuggestions) }]);
    await runAgent({
      anthropic: stub.client,
      event: { kind: 'anniversary', years: 5 },
      person,
      workspace,
      log: silentLog,
    });
    const firstUserMsg = stub.calls[0]?.messages[0];
    const text = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : '';
    expect(text).toContain('5-year work anniversary');
  });
});
