import { describe, expect, it } from 'vitest';
import { users, workspaces } from '@/db/schema';
import { createTestDb } from './db';

describe('single workspace admin constraint', () => {
  it('allows one admin and rejects a second admin in the same workspace', async () => {
    const db = await createTestDb();
    const workspaceId = '00000000-0000-4000-8000-000000000071';
    await db.insert(workspaces).values({
      id: workspaceId,
      slackTeamId: 'T_SINGLE_ADMIN',
      slackTeamName: 'Single Admin Test',
      botAccessTokenEnc: 'stub',
      installedBySlackUser: 'U_ADMIN',
    });
    await db.insert(users).values({
      workspaceId,
      slackUserId: 'U_ADMIN',
      isAdmin: true,
    });

    await expect(
      db.insert(users).values({
        workspaceId,
        slackUserId: 'U_SECOND',
        isAdmin: true,
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(users).values({
        workspaceId,
        slackUserId: 'U_MEMBER',
        isAdmin: false,
      }),
    ).resolves.toBeDefined();
  });
});
