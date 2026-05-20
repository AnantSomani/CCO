import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { findOrCreateEvents } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import {
  findMostRecentUnloggedPostForWorkspace,
  getPostByEventId,
  insertPost,
  updatePostSpend,
} from '@/db/queries/posts';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { createTestDb } from './db';

const seedEvent = async (db: Db): Promise<{ workspaceId: string; eventId: string }> => {
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
  return { workspaceId: ws.id, eventId: ev.id };
};

describe('posts queries', () => {
  it('insertPost is idempotent on event_id (returns null on second insert)', async () => {
    const db = await createTestDb();
    const { eventId } = await seedEvent(db);
    const first = await insertPost(db, {
      eventId,
      channelId: 'C1',
      slackTs: '111.222',
      threadTs: '111.222',
    });
    expect(first).not.toBeNull();
    const second = await insertPost(db, {
      eventId,
      channelId: 'C2',
      slackTs: '999.999',
    });
    expect(second).toBeNull();
    const back = await getPostByEventId(db, eventId);
    expect(back?.channelId).toBe('C1');
  });

  it('updatePostSpend records cents and timestamp', async () => {
    const db = await createTestDb();
    const { eventId } = await seedEvent(db);
    const post = await insertPost(db, {
      eventId,
      channelId: 'C1',
      slackTs: '111.222',
    });
    if (!post) throw new Error('insert returned null');
    await updatePostSpend(db, post.id, 4500);
    const back = await getPostByEventId(db, eventId);
    expect(back?.actualSpendCents).toBe(4500);
    expect(back?.spendLoggedAt).not.toBeNull();
  });

  it('findMostRecentUnloggedPostForWorkspace returns the most recent post without spend', async () => {
    const db = await createTestDb();
    const { workspaceId, eventId } = await seedEvent(db);
    const post = await insertPost(db, {
      eventId,
      channelId: 'C1',
      slackTs: '111.222',
    });
    expect(post).not.toBeNull();
    const found = await findMostRecentUnloggedPostForWorkspace(db, workspaceId);
    expect(found?.id).toBe(post?.id);

    if (post) await updatePostSpend(db, post.id, 1000);
    const afterLog = await findMostRecentUnloggedPostForWorkspace(db, workspaceId);
    expect(afterLog).toBeNull();
  });
});
