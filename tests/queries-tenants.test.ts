import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { getWorkspaceIdBySlug, upsertTenant } from '@/db/queries/tenants';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { createTestDb } from './db';

const seedWorkspace = async (db: Db, name = 'Acme'): Promise<string> => {
  const ws = await upsertWorkspace(db, {
    slackTeamId: `T_${Math.random().toString(36).slice(2, 10)}`,
    slackTeamName: name,
    installedBySlackUser: 'U_INSTALLER',
    botAccessToken: 'xoxb-test',
  });
  return ws.id;
};

describe('upsertTenant / getWorkspaceIdBySlug', () => {
  it('assigns a slug and resolves it back to the workspace', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db, 'Theta Software');
    const tenant = await upsertTenant(db, ws, 'theta');
    expect(tenant.slug).toBe('theta');
    expect(await getWorkspaceIdBySlug(db, 'theta')).toBe(ws);
  });

  it('returns null for an unknown slug', async () => {
    const db = await createTestDb();
    expect(await getWorkspaceIdBySlug(db, 'nope')).toBeNull();
  });

  it('is idempotent per workspace (re-pointing the slug)', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db);
    await upsertTenant(db, ws, 'theta');
    const again = await upsertTenant(db, ws, 'theta-software');
    expect(again.slug).toBe('theta-software');
    // Old slug no longer resolves; the workspace has exactly one slug.
    expect(await getWorkspaceIdBySlug(db, 'theta')).toBeNull();
    expect(await getWorkspaceIdBySlug(db, 'theta-software')).toBe(ws);
  });

  it('rejects a slug already taken by a different workspace', async () => {
    const db = await createTestDb();
    const wsA = await seedWorkspace(db, 'A');
    const wsB = await seedWorkspace(db, 'B');
    await upsertTenant(db, wsA, 'shared');
    await expect(upsertTenant(db, wsB, 'shared')).rejects.toThrow();
  });
});
