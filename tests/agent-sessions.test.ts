import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  appendSessionTurn,
  cancelOpenArtifacts,
  closeSession,
  expireStaleSessions,
  getOpenArtifact,
  getOpenSession,
  getOrCreateOpenSession,
  listRecentTurns,
  mergeArtifactSlots,
  summarizeArtifact,
  upsertOpenArtifact,
} from '@/db/queries/agent-sessions';
import { agentSessions, workspaces } from '@/db/schema';
import { createTestDb } from './db';

const WORKSPACE_A = '00000000-0000-4000-8000-000000000071';
const WORKSPACE_B = '00000000-0000-4000-8000-000000000072';

const seed = async () => {
  const db = await createTestDb();
  await db.insert(workspaces).values([
    {
      id: WORKSPACE_A,
      slackTeamId: 'T_A',
      slackTeamName: 'A',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    },
    {
      id: WORKSPACE_B,
      slackTeamId: 'T_B',
      slackTeamName: 'B',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_OTHER',
    },
  ]);
  return db;
};

describe('agent sessions', () => {
  it('keeps date then time on the same DoorDash draft', async () => {
    const db = await seed();
    const session = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_A,
      slackUserId: 'U_ADMIN',
    });
    await upsertOpenArtifact(db, {
      sessionId: session.id,
      workspaceId: WORKSPACE_A,
      kind: 'doordash_order',
      slots: { deliveryAt: '2026-08-22T19:00:00.000Z' },
    });
    const artifact = await getOpenArtifact(db, session.id, WORKSPACE_A);
    if (!artifact) throw new Error('missing artifact');
    const merged = await mergeArtifactSlots(db, {
      artifactId: artifact.id,
      workspaceId: WORKSPACE_A,
      slots: { restaurant: 'Local Pizza', estimatedCostCents: 5000 },
    });
    expect(merged?.slots.deliveryAt).toBe('2026-08-22T19:00:00.000Z');
    expect(merged?.slots.restaurant).toBe('Local Pizza');
    expect(merged?.missingSlots).toContain('deliveryAddress');
  });

  it('trims turns to the bounded window', async () => {
    const db = await seed();
    const session = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_A,
      slackUserId: 'U_ADMIN',
    });
    for (let index = 0; index < 15; index++) {
      await appendSessionTurn(db, {
        sessionId: session.id,
        workspaceId: WORKSPACE_A,
        role: 'user',
        text: `turn ${index}`,
      });
    }
    const turns = await listRecentTurns(db, session.id, WORKSPACE_A);
    expect(turns).toHaveLength(12);
    expect(turns[0]?.text).toBe('turn 3');
  });

  it('cancels and expires drafts without leaking across workspaces', async () => {
    const db = await seed();
    const sessionA = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_A,
      slackUserId: 'U_ADMIN',
    });
    const sessionB = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_B,
      slackUserId: 'U_OTHER',
    });
    await upsertOpenArtifact(db, {
      sessionId: sessionA.id,
      workspaceId: WORKSPACE_A,
      kind: 'reminder',
      slots: { title: 'Party', fireAt: '2026-08-23T00:00:00.000Z' },
    });
    await upsertOpenArtifact(db, {
      sessionId: sessionB.id,
      workspaceId: WORKSPACE_B,
      kind: 'reminder',
      slots: { title: 'Other', fireAt: '2026-08-23T00:00:00.000Z' },
    });
    expect(await cancelOpenArtifacts(db, sessionA.id, WORKSPACE_A)).toBe(1);
    expect((await getOpenArtifact(db, sessionA.id, WORKSPACE_A))?.kind).toBeUndefined();
    expect((await getOpenArtifact(db, sessionB.id, WORKSPACE_B))?.slots.title).toBe('Other');

    await db
      .update(agentSessions)
      .set({ expiresAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(agentSessions.id, sessionB.id));
    await expireStaleSessions(db, new Date('2026-08-22T00:00:00Z'));
    expect(await getOpenSession(db, WORKSPACE_B, 'U_OTHER')).toBeNull();
  });

  it('summarizes a DoorDash draft in plain language', async () => {
    const db = await seed();
    const session = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_A,
      slackUserId: 'U_ADMIN',
    });
    const artifact = await upsertOpenArtifact(db, {
      sessionId: session.id,
      workspaceId: WORKSPACE_A,
      kind: 'doordash_order',
      slots: {
        deliveryAt: '2025-08-22T18:30:00-04:00',
        deliveryAddress: '1056 Foxhurst Way, San Jose, CA 95120',
      },
    });
    const summary = summarizeArtifact(artifact);
    expect(summary).toContain('DoorDash order');
    expect(summary).toContain('Friday, August 22, 2025 at 6:30 PM');
    expect(summary).toContain('1056 Foxhurst Way, San Jose, CA 95120');
    expect(summary).toContain('a restaurant');
    expect(summary).not.toContain('deliveryAt');
    expect(summary).not.toContain('estimatedCostCents');
  });

  it('closes a session on cancel', async () => {
    const db = await seed();
    const session = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_A,
      slackUserId: 'U_ADMIN',
    });
    await closeSession(db, session.id, WORKSPACE_A);
    expect(await getOpenSession(db, WORKSPACE_A, 'U_ADMIN')).toBeNull();
  });
});
