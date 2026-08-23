import { describe, expect, it } from 'vitest';
import {
  getArtifactById,
  getOrCreateOpenSession,
  setArtifactStatus,
  upsertOpenArtifact,
} from '@/db/queries/agent-sessions';
import { workspaces } from '@/db/schema';
import { runAgentReminder } from '@/jobs/agent-reminder';
import { createTestDb } from './db';
import { recordingSlackClientFactory } from './slack-stub';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000081';

const seedReminder = async (status: 'scheduled' | 'cancelled') => {
  const db = await createTestDb();
  await db.insert(workspaces).values({
    id: WORKSPACE_ID,
    slackTeamId: 'T_REMIND',
    slackTeamName: 'Remind',
    botAccessTokenEnc: 'stub',
    installedBySlackUser: 'U_ADMIN',
  });
  const session = await getOrCreateOpenSession(db, {
    workspaceId: WORKSPACE_ID,
    slackUserId: 'U_ADMIN',
  });
  const artifact = await upsertOpenArtifact(db, {
    sessionId: session.id,
    workspaceId: WORKSPACE_ID,
    kind: 'reminder',
    slots: { title: 'Order cake', fireAt: '2026-08-22T18:00:00.000Z', note: 'Birthday party' },
  });
  await setArtifactStatus(db, artifact.id, WORKSPACE_ID, status, {
    fireAt: new Date('2026-08-22T18:00:00.000Z'),
  });
  return { db, artifactId: artifact.id };
};

describe('runAgentReminder', () => {
  it('delivers a scheduled reminder once', async () => {
    const { db, artifactId } = await seedReminder('scheduled');
    const first = await runAgentReminder({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      artifactId,
      workspaceId: WORKSPACE_ID,
      now: new Date('2026-08-22T18:00:01.000Z'),
    });
    const second = await runAgentReminder({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      artifactId,
      workspaceId: WORKSPACE_ID,
      now: new Date('2026-08-22T18:00:02.000Z'),
    });
    expect(first).toEqual({ ok: true, value: { delivered: true } });
    expect(second).toEqual({ ok: true, value: { delivered: false } });
    expect((await getArtifactById(db, artifactId, WORKSPACE_ID))?.status).toBe('completed');
  });

  it('does not fire a cancelled reminder', async () => {
    const { db, artifactId } = await seedReminder('cancelled');
    const result = await runAgentReminder({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      artifactId,
      workspaceId: WORKSPACE_ID,
      now: new Date('2026-08-22T18:00:01.000Z'),
    });
    expect(result).toEqual({ ok: true, value: { delivered: false } });
  });
});
