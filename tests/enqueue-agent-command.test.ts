import { describe, expect, it } from 'vitest';
import { agentRuns, users, workspaces } from '@/db/schema';
import { enqueueAgentCommand } from '@/slack/enqueue-agent-command';
import { createTestDb } from './db';
import { recordingEmitter } from './slack-stub';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000011';

const seed = async () => {
  const db = await createTestDb();
  await db.insert(workspaces).values({
    id: WORKSPACE_ID,
    slackTeamId: 'T_AGENT',
    slackTeamName: 'Agent Test',
    botAccessTokenEnc: 'stub',
    installedBySlackUser: 'U_ADMIN',
  });
  await db.insert(users).values([
    { workspaceId: WORKSPACE_ID, slackUserId: 'U_ADMIN', isAdmin: true },
    { workspaceId: WORKSPACE_ID, slackUserId: 'U_MEMBER', isAdmin: false },
  ]);
  return db;
};

describe('enqueueAgentCommand', () => {
  it('queues one durable event and deduplicates Slack retries', async () => {
    const db = await seed();
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const input = {
      slackTeamId: 'T_AGENT',
      slackUserId: 'U_ADMIN',
      requestText: 'what is our budget?',
      idempotencyKey: 'trigger-1',
    };

    const first = await enqueueAgentCommand(db, recordingEmitter(events), input);
    const duplicate = await enqueueAgentCommand(db, recordingEmitter(events), input);

    expect(first.ok && first.value.status).toBe('queued');
    expect(duplicate.ok && duplicate.value.status).toBe('duplicate');
    expect(events).toHaveLength(1);
  });

  it('blocks non-admin users before creating a run', async () => {
    const db = await seed();
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];

    const result = await enqueueAgentCommand(db, recordingEmitter(events), {
      slackTeamId: 'T_AGENT',
      slackUserId: 'U_MEMBER',
      requestText: 'show me the roster',
      idempotencyKey: 'trigger-2',
    });

    expect(result).toEqual({ ok: true, value: { status: 'unauthorized' } });
    expect(events).toHaveLength(0);
  });

  it('rate limits an admin after five requests in one minute', async () => {
    const db = await seed();
    await db.insert(agentRuns).values(
      Array.from({ length: 5 }, (_, index) => ({
        workspaceId: WORKSPACE_ID,
        requestedBySlackUser: 'U_ADMIN',
        requestText: `request ${index}`,
        idempotencyKey: `existing-${index}`,
      })),
    );

    const result = await enqueueAgentCommand(db, recordingEmitter([]), {
      slackTeamId: 'T_AGENT',
      slackUserId: 'U_ADMIN',
      requestText: 'one more request',
      idempotencyKey: 'trigger-rate-limited',
    });

    expect(result).toEqual({ ok: true, value: { status: 'rate_limited' } });
  });

  it('attaches queued requests to one open session', async () => {
    const db = await seed();
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    await enqueueAgentCommand(db, recordingEmitter(events), {
      slackTeamId: 'T_AGENT',
      slackUserId: 'U_ADMIN',
      requestText: 'Order pizza on August 22nd',
      idempotencyKey: 'session-1',
    });
    await enqueueAgentCommand(db, recordingEmitter(events), {
      slackTeamId: 'T_AGENT',
      slackUserId: 'U_ADMIN',
      requestText: '7pm',
      idempotencyKey: 'session-2',
    });
    const { agentRuns, agentSessionTurns } = await import('@/db/schema');
    const runs = await db.select().from(agentRuns);
    const turns = await db.select().from(agentSessionTurns);
    expect(new Set(runs.map((run) => run.sessionId)).size).toBe(1);
    expect(turns.map((turn) => turn.text)).toEqual(['Order pizza on August 22nd', '7pm']);
  });

  it('keeps DoorDash slots when a later /confetti continues the same session', async () => {
    const db = await seed();
    const { getOrCreateOpenSession, getOpenArtifact, upsertOpenArtifact } = await import(
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
      slots: {
        restaurant: 'Local Pizza',
        deliveryAt: '2026-08-22T19:00:00.000Z',
        estimatedCostCents: 5000,
      },
    });
    const result = await enqueueAgentCommand(db, recordingEmitter([]), {
      slackTeamId: 'T_AGENT',
      slackUserId: 'U_ADMIN',
      requestText: 'also get garlic knots',
      idempotencyKey: 'session-confetti-followup',
    });
    expect(result.ok && result.value.status).toBe('queued');
    const artifact = await getOpenArtifact(db, session.id, WORKSPACE_ID);
    expect(artifact?.kind).toBe('doordash_order');
    expect(artifact?.slots.restaurant).toBe('Local Pizza');
    expect(artifact?.slots.deliveryAt).toBe('2026-08-22T19:00:00.000Z');
    const { agentRuns } = await import('@/db/schema');
    const runs = await db.select().from(agentRuns);
    expect(runs.every((run) => run.sessionId === session.id)).toBe(true);
  });
});
