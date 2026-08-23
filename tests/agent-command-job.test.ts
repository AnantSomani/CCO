import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRun, getAgentRun } from '@/db/queries/agent-operations';
import { agentActions, workspaces } from '@/db/schema';
import { runAgentCommand } from '@/jobs/agent-command';
import { err, ok } from '@/lib/result';
import { createTestDb } from './db';
import { recordingSlackClientFactory } from './slack-stub';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000051';

describe('runAgentCommand', () => {
  it('persists proposals and sends separate response and confirmation DMs', async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({
      id: WORKSPACE_ID,
      slackTeamId: 'T_JOB',
      slackTeamName: 'Job Test',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    const { run } = await createAgentRun(db, {
      workspaceId: WORKSPACE_ID,
      requestedBySlackUser: 'U_ADMIN',
      requestText: 'set budget to $75',
      idempotencyKey: 'job-run',
    });
    const recorder: Parameters<typeof recordingSlackClientFactory>[0] = {};
    const runAdminAgent = vi.fn().mockResolvedValue(
      ok({
        replyText: 'I prepared the budget change.',
        proposedActions: [
          {
            kind: 'set_default_budget',
            summary: 'Set budget to $75',
            payload: { amountCents: 7500 },
            estimatedCostCents: null,
          },
        ],
        toolCalls: [{ name: 'propose_set_default_budget', input: { amount_usd: 75 } }],
        model: 'test-model',
        rounds: 2,
      }),
    );

    const result = await runAgentCommand({
      db,
      getSlackClient: recordingSlackClientFactory(recorder),
      getAnthropicClient: () => ({}) as Anthropic,
      runAdminAgent,
      runId: run.id,
    });

    const storedRun = await getAgentRun(db, run.id);
    const actions = await db.select().from(agentActions);
    expect(result).toEqual({ ok: true, value: { actionsCreated: 1 } });
    expect(storedRun?.status).toBe('completed');
    expect(storedRun?.toolCalls).toHaveLength(1);
    expect(actions[0]?.status).toBe('pending_confirmation');
    expect(recorder.posts).toHaveLength(2);
    expect(recorder.posts?.[1]?.blocks).toBeDefined();
  });

  it('handles cancel without calling the model', async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({
      id: WORKSPACE_ID,
      slackTeamId: 'T_JOB',
      slackTeamName: 'Job Test',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    const { getOrCreateOpenSession, upsertOpenArtifact, getOpenSession } = await import(
      '@/db/queries/agent-sessions'
    );
    const session = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_ID,
      slackUserId: 'U_ADMIN',
    });
    await upsertOpenArtifact(db, {
      sessionId: session.id,
      workspaceId: WORKSPACE_ID,
      kind: 'doordash_order',
      slots: { restaurant: 'Local Pizza' },
    });
    const { run } = await createAgentRun(db, {
      workspaceId: WORKSPACE_ID,
      requestedBySlackUser: 'U_ADMIN',
      requestText: 'cancel',
      idempotencyKey: 'cancel-run',
      sessionId: session.id,
    });
    const runAdminAgent = vi.fn();
    const result = await runAgentCommand({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      getAnthropicClient: () => ({}) as Anthropic,
      runAdminAgent,
      runId: run.id,
    });
    expect(result.ok).toBe(true);
    expect(runAdminAgent).not.toHaveBeenCalled();
    expect(await getOpenSession(db, WORKSPACE_ID, 'U_ADMIN')).toBeNull();
  });

  it('handles start over by clearing drafts and keeping the session', async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({
      id: WORKSPACE_ID,
      slackTeamId: 'T_JOB',
      slackTeamName: 'Job Test',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    const { getOrCreateOpenSession, upsertOpenArtifact, getOpenArtifact, getOpenSession } =
      await import('@/db/queries/agent-sessions');
    const session = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_ID,
      slackUserId: 'U_ADMIN',
    });
    await upsertOpenArtifact(db, {
      sessionId: session.id,
      workspaceId: WORKSPACE_ID,
      kind: 'doordash_order',
      slots: { restaurant: 'Local Pizza' },
    });
    const { run } = await createAgentRun(db, {
      workspaceId: WORKSPACE_ID,
      requestedBySlackUser: 'U_ADMIN',
      requestText: 'start over',
      idempotencyKey: 'restart-run',
      sessionId: session.id,
    });
    const recorder: Parameters<typeof recordingSlackClientFactory>[0] = {};
    const result = await runAgentCommand({
      db,
      getSlackClient: recordingSlackClientFactory(recorder),
      getAnthropicClient: () => ({}) as Anthropic,
      runAdminAgent: vi.fn(),
      runId: run.id,
    });
    expect(result.ok).toBe(true);
    expect(await getOpenSession(db, WORKSPACE_ID, 'U_ADMIN')).not.toBeNull();
    expect(await getOpenArtifact(db, session.id, WORKSPACE_ID)).toBeNull();
    expect(recorder.posts?.[0]?.text).toMatch(/Starting over/);
  });

  it('summarizes the current draft without calling the model', async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({
      id: WORKSPACE_ID,
      slackTeamId: 'T_JOB',
      slackTeamName: 'Job Test',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    const { getOrCreateOpenSession, upsertOpenArtifact } = await import(
      '@/db/queries/agent-sessions'
    );
    const session = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_ID,
      slackUserId: 'U_ADMIN',
    });
    await upsertOpenArtifact(db, {
      sessionId: session.id,
      workspaceId: WORKSPACE_ID,
      kind: 'reminder',
      slots: { title: 'Order cake', fireAt: '2026-08-23T18:00:00.000Z' },
    });
    const { run } = await createAgentRun(db, {
      workspaceId: WORKSPACE_ID,
      requestedBySlackUser: 'U_ADMIN',
      requestText: 'what do you have so far',
      idempotencyKey: 'summary-run',
      sessionId: session.id,
    });
    const recorder: Parameters<typeof recordingSlackClientFactory>[0] = {};
    const runAdminAgent = vi.fn();
    const result = await runAgentCommand({
      db,
      getSlackClient: recordingSlackClientFactory(recorder),
      getAnthropicClient: () => ({}) as Anthropic,
      runAdminAgent,
      runId: run.id,
    });
    expect(result.ok).toBe(true);
    expect(runAdminAgent).not.toHaveBeenCalled();
    expect(recorder.posts?.[0]?.text).toMatch(/Order cake/);
    expect(recorder.posts?.[0]?.text).toMatch(/reminder/);
    expect(recorder.posts?.[0]?.text).not.toMatch(/fireAt/);
  });

  it('DMs a timeout explanation instead of retrying the model', async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({
      id: WORKSPACE_ID,
      slackTeamId: 'T_JOB',
      slackTeamName: 'Job Test',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    const { run } = await createAgentRun(db, {
      workspaceId: WORKSPACE_ID,
      requestedBySlackUser: 'U_ADMIN',
      requestText: '1056 Foxhurst Way, San Jose, August 22 at 6:30pm for 6 people',
      idempotencyKey: 'timeout-run',
    });
    const recorder: Parameters<typeof recordingSlackClientFactory>[0] = {};
    const result = await runAgentCommand({
      db,
      getSlackClient: recordingSlackClientFactory(recorder),
      getAnthropicClient: () => ({}) as Anthropic,
      runAdminAgent: vi.fn().mockResolvedValue(err('admin agent timed out after 60000ms')),
      runId: run.id,
    });
    const storedRun = await getAgentRun(db, run.id);
    expect(result).toEqual({ ok: true, value: { actionsCreated: 0 } });
    expect(storedRun?.status).toBe('completed');
    expect(recorder.posts?.[0]?.text).toMatch(/timed out/);
    expect(recorder.posts?.[0]?.text).toMatch(/what do you have so far/);
  });
});
