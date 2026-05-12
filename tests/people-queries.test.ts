import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import {
  findAnniversaryCandidates,
  findBirthdayCandidates,
  upsertPeople,
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

const utc = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

describe('upsertPeople', () => {
  it('inserts all rows on first call', async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    const counts = await upsertPeople(db, workspaceId, [
      {
        name: 'Alice',
        email: 'alice@example.com',
        birthdayMonth: 3,
        birthdayDay: 15,
        startDate: utc(2020, 6, 1),
        team: 'Eng',
        role: 'Engineer',
      },
      {
        name: 'Bob',
        email: 'bob@example.com',
        birthdayMonth: 12,
        birthdayDay: 31,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    expect(counts).toEqual({ inserted: 2, updated: 0 });
  });

  it('updates on second call with same emails', async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    await upsertPeople(db, workspaceId, [
      {
        name: 'Alice',
        email: 'alice@example.com',
        birthdayMonth: 3,
        birthdayDay: 15,
        startDate: utc(2020, 6, 1),
        team: null,
        role: null,
      },
    ]);
    const counts = await upsertPeople(db, workspaceId, [
      {
        name: 'Alice Apple', // changed
        email: 'alice@example.com',
        birthdayMonth: 3,
        birthdayDay: 15,
        startDate: utc(2020, 6, 1),
        team: 'Eng', // new
        role: null,
      },
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 1 });
    const candidates = await findBirthdayCandidates(db, workspaceId, 3, 15);
    expect(candidates[0]?.name).toBe('Alice Apple');
    expect(candidates[0]?.team).toBe('Eng');
  });

  it('returns mixed insert/update counts', async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    await upsertPeople(db, workspaceId, [
      {
        name: 'Alice',
        email: 'alice@example.com',
        birthdayMonth: 3,
        birthdayDay: 15,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    const counts = await upsertPeople(db, workspaceId, [
      {
        name: 'Alice',
        email: 'alice@example.com',
        birthdayMonth: 3,
        birthdayDay: 15,
        startDate: null,
        team: null,
        role: null,
      },
      {
        name: 'Bob',
        email: 'bob@example.com',
        birthdayMonth: 5,
        birthdayDay: 1,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    expect(counts).toEqual({ inserted: 1, updated: 1 });
  });

  it('preserves opted_out across re-uploads', async () => {
    const db = await createTestDb();
    const { people: peopleTable } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const workspaceId = await seedWorkspace(db);
    await upsertPeople(db, workspaceId, [
      {
        name: 'Alice',
        email: 'alice@example.com',
        birthdayMonth: 3,
        birthdayDay: 15,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    await db
      .update(peopleTable)
      .set({ optedOut: true })
      .where(eq(peopleTable.email, 'alice@example.com'));
    await upsertPeople(db, workspaceId, [
      {
        name: 'Alice (renamed)',
        email: 'alice@example.com',
        birthdayMonth: 3,
        birthdayDay: 15,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    const candidates = await findBirthdayCandidates(db, workspaceId, 3, 15);
    expect(candidates).toHaveLength(0); // still opted out
  });

  it('handles an empty rows array', async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    expect(await upsertPeople(db, workspaceId, [])).toEqual({ inserted: 0, updated: 0 });
  });
});

describe('findBirthdayCandidates', () => {
  it('filters by month + day, excludes opted-out, scopes by workspace', async () => {
    const db = await createTestDb();
    const wsA = await seedWorkspace(db);
    const wsB = await seedWorkspace(db);
    await upsertPeople(db, wsA, [
      {
        name: 'Match',
        email: 'match@example.com',
        birthdayMonth: 5,
        birthdayDay: 19,
        startDate: null,
        team: null,
        role: null,
      },
      {
        name: 'OffByOne',
        email: 'off@example.com',
        birthdayMonth: 5,
        birthdayDay: 18,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    await upsertPeople(db, wsB, [
      {
        name: 'OtherWorkspace',
        email: 'match@other.com',
        birthdayMonth: 5,
        birthdayDay: 19,
        startDate: null,
        team: null,
        role: null,
      },
    ]);
    const candidates = await findBirthdayCandidates(db, wsA, 5, 19);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('Match');
  });
});

describe('findAnniversaryCandidates', () => {
  it('filters by start_date month+day < today, excludes opted-out', async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    await upsertPeople(db, workspaceId, [
      {
        name: 'PastStart',
        email: 'past@example.com',
        birthdayMonth: null,
        birthdayDay: null,
        startDate: utc(2020, 5, 26),
        team: null,
        role: null,
      },
      {
        name: 'FutureStart',
        email: 'future@example.com',
        birthdayMonth: null,
        birthdayDay: null,
        startDate: utc(2030, 5, 26),
        team: null,
        role: null,
      },
      {
        name: 'WrongDay',
        email: 'wrong@example.com',
        birthdayMonth: null,
        birthdayDay: null,
        startDate: utc(2020, 5, 25),
        team: null,
        role: null,
      },
    ]);
    const candidates = await findAnniversaryCandidates(db, workspaceId, 5, 26, '2026-05-12');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('PastStart');
  });
});
