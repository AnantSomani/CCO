import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { RunAgentArgs } from '@/agent/index';
import type { AgentResult } from '@/agent/types';
import type { Db } from '@/db/client';
import { findOrCreateEvents, getEventById } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import { getSuggestionsByEventId } from '@/db/queries/suggestions';
import { upsertUser } from '@/db/queries/users';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { runGenerateSuggestions } from '@/jobs/generate-suggestions';
import { createTestDb } from './db';
import { type RecordingSlackClient, recordingSlackClientFactory } from './slack-stub';

const seed = async (db: Db) => {
  const ws = await upsertWorkspace(db, {
    slackTeamId: `T_${Math.random().toString(36).slice(2, 10)}`,
    slackTeamName: 'Acme',
    installedBySlackUser: 'U_ADMIN',
    botAccessToken: 'xoxb-test',
  });
  await upsertUser(db, { workspaceId: ws.id, slackUserId: 'U_ADMIN', isAdmin: true });
  await upsertPeople(db, ws.id, [
    {
      name: 'Alice Park',
      email: 'a@x.com',
      birthdayMonth: 5,
      birthdayDay: 25,
      startDate: null,
      team: null,
      role: null,
    },
  ]);
  const person = await db.query.people.findFirst();
  if (!person) throw new Error('seed person missing');
  const events = await findOrCreateEvents(db, [
    {
      workspaceId: ws.id,
      personId: person.id,
      kind: 'birthday',
      eventDate: '2026-05-25',
      years: null,
    },
  ]);
  const ev = events[0];
  if (!ev) throw new Error('seed event missing');
  return { workspaceId: ws.id, eventId: ev.id };
};

// Stub Anthropic client that throws if anyone actually tries to call it. The
// mock runAgent never touches it; this exists to satisfy the type and catch
// accidental real-network usage in tests.
const explodingAnthropic = (() => {
  const fail = () => {
    throw new Error('explodingAnthropic: should not be called in tests');
  };
  return { messages: { create: fail } } as unknown as Anthropic;
})();
const explodingGetAnthropicClient = () => explodingAnthropic;

// Hand-rolled agent stub. Captures what runAgent was called with so tests can
// assert on the context (event kind, budget, person fields).
type AgentInvocation = { args: RunAgentArgs; result: AgentResult };

const mockAgent = (result: AgentResult) => {
  const calls: AgentInvocation[] = [];
  const run = async (args: RunAgentArgs): Promise<AgentResult> => {
    calls.push({ args, result });
    return result;
  };
  return { run, calls };
};

const validAgentResult: AgentResult = {
  ok: true,
  usedFallback: false,
  rounds: 1,
  toolCalls: [{ name: 'propose_suggestions', input: {} }],
  suggestions: [
    {
      gestureSummary: 'Card from the team',
      gestureDetails: { source: 'agent', kind: 'birthday', rank: 1, rationale: 'r1' },
      estimatedCostCents: 1500,
      rank: 1,
    },
    {
      gestureSummary: 'Coffee on the team',
      gestureDetails: { source: 'agent', kind: 'birthday', rank: 2, rationale: 'r2' },
      estimatedCostCents: 2500,
      rank: 2,
    },
  ],
};

describe('runGenerateSuggestions', () => {
  it('calls the agent, inserts its suggestions, DMs the admin, stashes channel+ts', async () => {
    const db = await createTestDb();
    const { eventId } = await seed(db);
    const slack: RecordingSlackClient = {};
    const agent = mockAgent(validAgentResult);

    const result = await runGenerateSuggestions({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      getAnthropicClient: explodingGetAnthropicClient,
      runAgent: agent.run,
      eventId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestionsCreated).toBe(2);
    expect(result.value.usedFallback).toBe(false);

    const sugs = await getSuggestionsByEventId(db, eventId);
    expect(sugs).toHaveLength(2);
    expect(sugs.map((s) => s.gestureSummary).sort()).toEqual([
      'Card from the team',
      'Coffee on the team',
    ]);

    expect(slack.posts).toHaveLength(1);
    expect(slack.posts?.[0]?.channel).toBe('U_ADMIN');
    expect(slack.posts?.[0]?.text).toContain('birthday');

    const ev = await getEventById(db, eventId);
    expect(ev?.status).toBe('pending');
    expect(ev?.approvalDmChannelId).toBe('D_U_ADMIN');
    expect(ev?.approvalDmTs).toBeTruthy();

    // The agent received the trimmed context shape we built from the bundle.
    expect(agent.calls).toHaveLength(1);
    const call = agent.calls[0];
    expect(call?.args.event.kind).toBe('birthday');
    expect(call?.args.person.name).toBe('Alice Park');
    expect(call?.args.workspace.defaultBudgetCents).toBe(5000);
    expect(call?.args.workspace.teamName).toBe('Acme');
    expect(call?.args.slackClient).toBeDefined();
    expect(call?.args.listRecentGestures).toBeDefined();
  });

  it('persists the agent fallback path and marks usedFallback:true on the run result', async () => {
    const db = await createTestDb();
    const { eventId } = await seed(db);
    const slack: RecordingSlackClient = {};
    const fallbackAgent = mockAgent({
      ok: true,
      usedFallback: true,
      rounds: 5,
      toolCalls: [],
      suggestions: [
        {
          gestureSummary: 'Card from the team',
          gestureDetails: { source: 'fallback', kind: 'birthday', rank: 1 },
          estimatedCostCents: 3000,
          rank: 1,
        },
      ],
      error: 'max_rounds_exceeded_no_terminal_call',
    });

    const result = await runGenerateSuggestions({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      getAnthropicClient: explodingGetAnthropicClient,
      runAgent: fallbackAgent.run,
      eventId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestionsCreated).toBe(1);
    expect(result.value.usedFallback).toBe(true);

    const sugs = await getSuggestionsByEventId(db, eventId);
    expect(sugs).toHaveLength(1);
    expect(sugs[0]?.gestureDetails).toMatchObject({ source: 'fallback' });
    // Even a fallback path must produce a DM — never silently drop the event.
    expect(slack.posts).toHaveLength(1);
  });

  it('returns err and does not DM when the agent reports a precondition failure', async () => {
    const db = await createTestDb();
    const { eventId } = await seed(db);
    const slack: RecordingSlackClient = {};
    const failingAgent = mockAgent({ ok: false, error: 'workspace budget is non-positive: 0' });

    const result = await runGenerateSuggestions({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      getAnthropicClient: explodingGetAnthropicClient,
      runAgent: failingAgent.run,
      eventId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('agent');
    expect(slack.posts ?? []).toHaveLength(0);
    const sugs = await getSuggestionsByEventId(db, eventId);
    expect(sugs).toHaveLength(0);
  });

  it('is idempotent: second invocation skips when suggestions already exist (agent not re-called)', async () => {
    const db = await createTestDb();
    const { eventId } = await seed(db);
    const slack: RecordingSlackClient = {};
    const agent = mockAgent(validAgentResult);
    const ctx = {
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      getAnthropicClient: explodingGetAnthropicClient,
      runAgent: agent.run,
      eventId,
    };

    await runGenerateSuggestions(ctx);
    const second = await runGenerateSuggestions(ctx);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.suggestionsCreated).toBe(0);
    expect(slack.posts).toHaveLength(1);
    // Agent only invoked the first time.
    expect(agent.calls).toHaveLength(1);
  });

  it('returns err if event does not exist', async () => {
    const db = await createTestDb();
    const result = await runGenerateSuggestions({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      getAnthropicClient: explodingGetAnthropicClient,
      runAgent: vi.fn(),
      eventId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
  });
});
