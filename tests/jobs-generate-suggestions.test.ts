import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { findOrCreateEvents, getEventById } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import { getSuggestionsByEventId } from '@/db/queries/suggestions';
import { upsertUser } from '@/db/queries/users';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { runGenerateSuggestions } from '@/jobs/generate-suggestions';
import { createTestDb } from './db';
import { type RecordingSlackClient, recordingSlackClientFactory } from './slack-stub';

const seed = async (db: Db) => {
  const ws = await upsertWorkspace(db, {
    slackTeamId: `T_${Math.random().toString(36).slice(2, 10)}`,
    slackTeamName: 'Acme',
    installedBySlackUser: 'U_ADMIN',
    botAccessToken: 'xoxb-test',
  });
  await upsertUser(db, { workspaceId: ws.id, slackUserId: 'U_ADMIN', isAdmin: true });
  await upsertPeople(db, ws.id, [
    {
      name: 'Alice Park',
      email: 'a@x.com',
      birthdayMonth: 5,
      birthdayDay: 25,
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
      eventDate: '2026-05-25',
      years: null,
    },
  ]);
  const ev = events[0];
  if (!ev) throw new Error('seed event missing');
  return { workspaceId: ws.id, eventId: ev.id };
};

describe('runGenerateSuggestions', () => {
  it('inserts 2 suggestions, DMs the admin, stashes channel+ts, leaves status pending', async () => {
    const db = await createTestDb();
    const { eventId } = await seed(db);
    const slack: RecordingSlackClient = {};
    const result = await runGenerateSuggestions({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      eventId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestionsCreated).toBe(2);
    const sugs = await getSuggestionsByEventId(db, eventId);
    expect(sugs).toHaveLength(2);

    expect(slack.posts).toHaveLength(1);
    expect(slack.posts?.[0]?.channel).toBe('U_ADMIN');
    expect(slack.posts?.[0]?.text).toContain('birthday');

    const ev = await getEventById(db, eventId);
    expect(ev?.status).toBe('pending');
    expect(ev?.approvalDmChannelId).toBe('D_U_ADMIN'); // stub maps U_ → D_U_
    expect(ev?.approvalDmTs).toBeTruthy();
  });

  it('is idempotent: second invocation skips when suggestions already exist', async () => {
    const db = await createTestDb();
    const { eventId } = await seed(db);
    const slack: RecordingSlackClient = {};
    const ctx = { db, getSlackClient: recordingSlackClientFactory(slack), eventId };
    await runGenerateSuggestions(ctx);
    const second = await runGenerateSuggestions(ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.suggestionsCreated).toBe(0);
    // Only one DM total.
    expect(slack.posts).toHaveLength(1);
  });

  it('returns err if event does not exist', async () => {
    const db = await createTestDb();
    const result = await runGenerateSuggestions({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      eventId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
  });
});
