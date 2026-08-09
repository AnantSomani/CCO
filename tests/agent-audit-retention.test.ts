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
});
