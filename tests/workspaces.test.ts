import { describe, expect, it } from 'vitest';
import {
  getWorkspaceBotAccessToken,
  getWorkspaceById,
  getWorkspaceBySlackTeamId,
  upsertWorkspace,
} from '@/db/queries/workspaces';
import { workspaces } from '@/db/schema';
import { createTestDb } from './db';

describe('upsertWorkspace', () => {
  it('inserts a new row on first call', async () => {
    const db = await createTestDb();
    const ws = await upsertWorkspace(db, {
      slackTeamId: 'T_FIRST',
      slackTeamName: 'Acme',
      installedBySlackUser: 'U_INSTALLER',
      botAccessToken: 'xoxb-original',
    });
    expect(ws.slackTeamId).toBe('T_FIRST');
    expect(ws.slackTeamName).toBe('Acme');
    expect(ws.installedBySlackUser).toBe('U_INSTALLER');
    expect(typeof ws.id).toBe('string');

    const all = await db.select().from(workspaces);
    expect(all).toHaveLength(1);
  });

  it('encrypts the token at rest', async () => {
    const db = await createTestDb();
    const ws = await upsertWorkspace(db, {
      slackTeamId: 'T_ENC',
      slackTeamName: 'Acme',
      installedBySlackUser: 'U1',
      botAccessToken: 'xoxb-plaintext-secret',
    });
    const [row] = await db.select().from(workspaces);
    expect(row?.botAccessTokenEnc).not.toBe('xoxb-plaintext-secret');
    expect(row?.botAccessTokenEnc).not.toContain('xoxb');

    const decrypted = await getWorkspaceBotAccessToken(db, ws.id);
    expect(decrypted).toBe('xoxb-plaintext-secret');
  });
});

describe('getWorkspaceById / getWorkspaceBySlackTeamId', () => {
  it('returns null when not found', async () => {
    const db = await createTestDb();
    expect(await getWorkspaceById(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await getWorkspaceBySlackTeamId(db, 'T_NONE')).toBeNull();
  });

  it('returns the workspace by slack_team_id', async () => {
    const db = await createTestDb();
    const ws = await upsertWorkspace(db, {
      slackTeamId: 'T_LOOKUP',
      slackTeamName: 'Lookup Co',
      installedBySlackUser: 'U1',
      botAccessToken: 'xoxb-1',
    });
    const found = await getWorkspaceBySlackTeamId(db, 'T_LOOKUP');
    expect(found?.id).toBe(ws.id);
    expect(found?.slackTeamName).toBe('Lookup Co');
  });

  it('does not include the token in the returned shape', async () => {
    const db = await createTestDb();
    const ws = await upsertWorkspace(db, {
      slackTeamId: 'T_TOKLESS',
      slackTeamName: 'Acme',
      installedBySlackUser: 'U1',
      botAccessToken: 'xoxb-secret',
    });
    const found = await getWorkspaceById(db, ws.id);
    expect(found).not.toBeNull();
    // The Workspace shape has no token-bearing field at all.
    expect(Object.keys(found ?? {})).not.toContain('botAccessTokenEnc');
  });

  it('returns null token for an unknown workspace id', async () => {
    const db = await createTestDb();
    const token = await getWorkspaceBotAccessToken(db, '00000000-0000-0000-0000-000000000000');
    expect(token).toBeNull();
  });
});
