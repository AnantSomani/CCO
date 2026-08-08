import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import {
  deletePerson,
  insertPerson,
  listPeople,
  type PersonWrite,
  setOptedOutById,
  updatePerson,
} from '@/db/queries/people';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { createTestDb } from './db';

const seedWorkspace = async (db: Db): Promise<string> => {
  const ws = await upsertWorkspace(db, {
    slackTeamId: `T_${Math.random().toString(36).slice(2, 10)}`,
    slackTeamName: 'Acme',
    installedBySlackUser: 'U_INSTALLER',
    botAccessToken: 'xoxb-test',
  });
  return ws.id;
};

const fields = (over: Partial<PersonWrite> = {}): PersonWrite => ({
  name: 'Jordan',
  birthdayMonth: 3,
  birthdayDay: 15,
  startDate: '2021-06-01',
  team: 'Eng',
  role: 'Engineer',
  ...over,
});

describe('insertPerson', () => {
  it('inserts a new person and returns it', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db);
    const person = await insertPerson(db, ws, 'jordan@acme.com', fields());
    expect(person?.name).toBe('Jordan');
    expect(person?.email).toBe('jordan@acme.com');
    expect(person?.optedOut).toBe(false);
  });

  it('returns null on duplicate email within the workspace', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db);
    await insertPerson(db, ws, 'dup@acme.com', fields());
    const second = await insertPerson(db, ws, 'dup@acme.com', fields({ name: 'Other' }));
    expect(second).toBeNull();
  });

  it('allows the same email in a different workspace', async () => {
    const db = await createTestDb();
    const wsA = await seedWorkspace(db);
    const wsB = await seedWorkspace(db);
    await insertPerson(db, wsA, 'same@acme.com', fields());
    const b = await insertPerson(db, wsB, 'same@acme.com', fields());
    expect(b).not.toBeNull();
  });
});

describe('listPeople', () => {
  it('returns the whole workspace roster including opted-out, ordered by name', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db);
    await insertPerson(db, ws, 'z@acme.com', fields({ name: 'Zoe' }));
    const opted = await insertPerson(db, ws, 'a@acme.com', fields({ name: 'Aaron' }));
    if (opted) await setOptedOutById(db, ws, opted.id, true);

    const roster = await listPeople(db, ws);
    expect(roster.map((p) => p.name)).toEqual(['Aaron', 'Zoe']);
    expect(roster.find((p) => p.name === 'Aaron')?.optedOut).toBe(true);
  });

  it('scopes to the workspace', async () => {
    const db = await createTestDb();
    const wsA = await seedWorkspace(db);
    const wsB = await seedWorkspace(db);
    await insertPerson(db, wsA, 'a@acme.com', fields());
    await insertPerson(db, wsB, 'b@acme.com', fields());
    expect(await listPeople(db, wsA)).toHaveLength(1);
  });
});

describe('updatePerson', () => {
  it('updates mutable fields', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db);
    const person = await insertPerson(db, ws, 'jordan@acme.com', fields());
    if (!person) throw new Error('setup failed');
    const updated = await updatePerson(
      db,
      ws,
      person.id,
      fields({ name: 'Jordan Lee', team: 'Design' }),
    );
    expect(updated?.name).toBe('Jordan Lee');
    expect(updated?.team).toBe('Design');
    // Email is not mutated by update.
    expect(updated?.email).toBe('jordan@acme.com');
  });

  it('returns null for a cross-workspace id', async () => {
    const db = await createTestDb();
    const wsA = await seedWorkspace(db);
    const wsB = await seedWorkspace(db);
    const person = await insertPerson(db, wsA, 'jordan@acme.com', fields());
    if (!person) throw new Error('setup failed');
    const result = await updatePerson(db, wsB, person.id, fields({ name: 'Hacked' }));
    expect(result).toBeNull();
  });
});

describe('deletePerson', () => {
  it('deletes a person and returns true', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db);
    const person = await insertPerson(db, ws, 'jordan@acme.com', fields());
    if (!person) throw new Error('setup failed');
    expect(await deletePerson(db, ws, person.id)).toBe(true);
    expect(await listPeople(db, ws)).toHaveLength(0);
  });

  it('will not delete across workspaces', async () => {
    const db = await createTestDb();
    const wsA = await seedWorkspace(db);
    const wsB = await seedWorkspace(db);
    const person = await insertPerson(db, wsA, 'jordan@acme.com', fields());
    if (!person) throw new Error('setup failed');
    expect(await deletePerson(db, wsB, person.id)).toBe(false);
    expect(await listPeople(db, wsA)).toHaveLength(1);
  });
});

describe('setOptedOutById', () => {
  it('toggles opt-out state', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db);
    const person = await insertPerson(db, ws, 'jordan@acme.com', fields());
    if (!person) throw new Error('setup failed');
    expect(await setOptedOutById(db, ws, person.id, true)).toBe(true);
    const roster = await listPeople(db, ws);
    expect(roster[0]?.optedOut).toBe(true);
  });

  it('returns false for unknown id', async () => {
    const db = await createTestDb();
    const ws = await seedWorkspace(db);
    expect(await setOptedOutById(db, ws, '00000000-0000-0000-0000-000000000000', true)).toBe(false);
  });
});
