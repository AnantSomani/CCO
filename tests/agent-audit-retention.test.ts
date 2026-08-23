import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentRuns, workspaces } from '@/db/schema';
import { runAgentAuditRetention } from '@/jobs/agent-audit-retention';
import { createTestDb } from './db';

describe('runAgentAuditRetention', () => {
  it('deletes only terminal runs older than 90 days', async () => {
    const db = await createTestDb();
    const workspaceId = '00000000-0000-4000-8000-000000000061';
    await db.insert(workspaces).values({
      id: workspaceId,
      slackTeamId: 'T_RETENTION',
      slackTeamName: 'Retention Test',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    await db.insert(agentRuns).values([
      {
        workspaceId,
        requestedBySlackUser: 'U_ADMIN',
        requestText: 'old complete',
        status: 'completed',
        idempotencyKey: 'old-complete',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        workspaceId,
        requestedBySlackUser: 'U_ADMIN',
        requestText: 'old pending',
        status: 'queued',
        idempotencyKey: 'old-pending',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        workspaceId,
        requestedBySlackUser: 'U_ADMIN',
        requestText: 'recent complete',
        status: 'completed',
        idempotencyKey: 'recent-complete',
        createdAt: new Date('2026-07-15T00:00:00Z'),
      },
    ]);

    const result = await runAgentAuditRetention(db, new Date('2026-08-08T00:00:00Z'));
    const remaining = await db.select({ key: agentRuns.idempotencyKey }).from(agentRuns);

    expect(result).toEqual({ deleted: 1 });
    expect(remaining.map((row) => row.key).sort()).toEqual(['old-pending', 'recent-complete']);
  });

  it('deletes closed sessions older than 90 days and expires idle ones', async () => {
    const db = await createTestDb();
    const workspaceId = '00000000-0000-4000-8000-000000000062';
    await db.insert(workspaces).values({
      id: workspaceId,
      slackTeamId: 'T_RETENTION_SESSIONS',
      slackTeamName: 'Retention Sessions',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    const { agentSessions } = await import('@/db/schema');
    const { getOrCreateOpenSession, closeSession } = await import('@/db/queries/agent-sessions');
    const staleOpen = await getOrCreateOpenSession(db, {
      workspaceId,
      slackUserId: 'U_STALE',
    });
    await db
      .update(agentSessions)
      .set({ expiresAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(agentSessions.id, staleOpen.id));
    const closed = await getOrCreateOpenSession(db, {
      workspaceId,
      slackUserId: 'U_CLOSED',
    });
    await closeSession(db, closed.id, workspaceId);
    await db
      .update(agentSessions)
      .set({ updatedAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(agentSessions.id, closed.id));
    const recent = await getOrCreateOpenSession(db, {
      workspaceId,
      slackUserId: 'U_RECENT',
    });

    const result = await runAgentAuditRetention(db, new Date('2026-08-08T00:00:00Z'));
    const remaining = await db.select().from(agentSessions);
    const remainingById = new Map(remaining.map((row) => [row.id, row]));

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(remainingById.has(closed.id)).toBe(false);
    expect(remainingById.get(staleOpen.id)?.status).toBe('closed');
    expect(remainingById.get(recent.id)?.status).toBe('active');
  });
});
