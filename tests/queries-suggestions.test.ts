import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { findOrCreateEvents } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import { getSuggestionsByEventId, insertSuggestions } from '@/db/queries/suggestions';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { createTestDb } from './db';

const seedEvent = async (db: Db): Promise<string> => {
  const ws = await upsertWorkspace(db, {
    slackTeamId: `T_${Math.random().toString(36).slice(2, 10)}`,
    slackTeamName: 'Acme',
    installedBySlackUser: 'U1',
    botAccessToken: 'xoxb-test',
  });
  await upsertPeople(db, ws.id, [
    {
      name: 'Alice',
      email: 'a@x.com',
      birthdayMonth: 5,
      birthdayDay: 19,
      startDate: null,
      team: null,
      role: null,
    },
  ]);
  const person = await db.query.people.findFirst();
  if (!person) throw new Error('seed person missing');
  const events = await findOrCreateEvents(db, [
    {
      workspaceId: ws.id,
      personId: person.id,
      kind: 'birthday',
      eventDate: '2026-05-19',
      years: null,
    },
  ]);
  const ev = events[0];
  if (!ev) throw new Error('seed event missing');
  return ev.id;
};

describe('insertSuggestions / getSuggestionsByEventId', () => {
  it('round-trips bulk insert and orders by rank ascending', async () => {
    const db = await createTestDb();
    const eventId = await seedEvent(db);
    const inserted = await insertSuggestions(db, eventId, [
      {
        gestureSummary: 'Second',
        gestureDetails: { foo: 'bar' },
        estimatedCostCents: 2000,
        rank: 2,
      },
      {
        gestureSummary: 'First',
        gestureDetails: {},
        estimatedCostCents: 1000,
        rank: 1,
      },
    ]);
    expect(inserted).toHaveLength(2);
    const back = await getSuggestionsByEventId(db, eventId);
    expect(back.map((s) => s.rank)).toEqual([1, 2]);
    expect(back[0]?.gestureSummary).toBe('First');
  });

  it('returns empty array on empty input', async () => {
    const db = await createTestDb();
    const eventId = await seedEvent(db);
    expect(await insertSuggestions(db, eventId, [])).toEqual([]);
  });
});
