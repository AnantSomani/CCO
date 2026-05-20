import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { insertApproval } from '@/db/queries/approvals';
import { findOrCreateEvents, getEventById } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import { getPostByEventId, insertPost } from '@/db/queries/posts';
import { upsertUser } from '@/db/queries/users';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { workspaces } from '@/db/schema';
import { runDayOfPost } from '@/jobs/day-of-post';
import { createTestDb } from './db';
import { type RecordingSlackClient, recordingSlackClientFactory } from './slack-stub';

type Seed = {
  db: Db;
  workspaceId: string;
  userId: string;
  eventId: string;
};

const seed = async (opts?: { channel?: string | null }): Promise<Seed> => {
  const db = await createTestDb();
  const ws = await upsertWorkspace(db, {
    slackTeamId: `T_${Math.random().toString(36).slice(2, 10)}`,
    slackTeamName: 'Acme',
    installedBySlackUser: 'U_ADMIN',
    botAccessToken: 'xoxb-test',
  });
  const channel = opts?.channel === undefined ? 'C_CELEBRATE' : opts.channel;
  await db
    .update(workspaces)
    .set({ celebrationChannelId: channel })
    .where(eq(workspaces.id, ws.id));
  const user = await upsertUser(db, {
    workspaceId: ws.id,
    slackUserId: 'U_ADMIN',
    isAdmin: true,
  });
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
  return { db, workspaceId: ws.id, userId: user.id, eventId: ev.id };
};

describe('runDayOfPost', () => {
  it('happy path: posts celebration + thread + DMs admin, inserts post row, status → posted', async () => {
    const { db, userId, eventId } = await seed();
    await insertApproval(db, {
      eventId,
      approverUserId: userId,
      decision: 'modified',
      customGestureText: 'Send them flowers',
      approvedBudgetCents: 4500,
    });
    const slack: RecordingSlackClient = {};
    const result = await runDayOfPost({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      eventId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ posted: true });
    // 3 messages: top-of-channel + thread + admin DM
    expect(slack.posts).toHaveLength(3);
    expect(slack.posts?.[0]?.channel).toBe('C_CELEBRATE');
    expect(slack.posts?.[1]?.thread_ts).toBeTruthy();
    expect(slack.posts?.[2]?.channel).toBe('U_ADMIN');
    const post = await getPostByEventId(db, eventId);
    expect(post).not.toBeNull();
    const ev = await getEventById(db, eventId);
    expect(ev?.status).toBe('posted');
  });

  it('guard: no approval → returns posted:false reason no_approval, no slack calls', async () => {
    const { db, eventId } = await seed();
    const slack: RecordingSlackClient = {};
    const result = await runDayOfPost({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      eventId,
    });
    expect(result.ok && (result.value as { reason: string }).reason).toBe('no_approval');
    expect(slack.posts ?? []).toHaveLength(0);
  });

  it('guard: approval skipped → reason skipped, no slack calls', async () => {
    const { db, userId, eventId } = await seed();
    await insertApproval(db, { eventId, approverUserId: userId, decision: 'skipped' });
    const slack: RecordingSlackClient = {};
    const result = await runDayOfPost({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      eventId,
    });
    expect(result.ok && (result.value as { reason: string }).reason).toBe('skipped');
    expect(slack.posts ?? []).toHaveLength(0);
  });

  it('guard: post already exists → reason already_posted, no double-post', async () => {
    const { db, userId, eventId } = await seed();
    await insertApproval(db, { eventId, approverUserId: userId, decision: 'approved' });
    await insertPost(db, {
      eventId,
      channelId: 'C_CELEBRATE',
      slackTs: '111.222',
    });
    const slack: RecordingSlackClient = {};
    const result = await runDayOfPost({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      eventId,
    });
    expect(result.ok && (result.value as { reason: string }).reason).toBe('already_posted');
    expect(slack.posts ?? []).toHaveLength(0);
  });

  it('guard: no celebration channel → DM admin, reason no_celebration_channel, no post', async () => {
    const { db, userId, eventId } = await seed({ channel: null });
    await insertApproval(db, { eventId, approverUserId: userId, decision: 'approved' });
    const slack: RecordingSlackClient = {};
    const result = await runDayOfPost({
      db,
      getSlackClient: recordingSlackClientFactory(slack),
      eventId,
    });
    expect(result.ok && (result.value as { reason: string }).reason).toBe('no_celebration_channel');
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts?.[0]?.channel).toBe('U_ADMIN');
    expect(slack.posts?.[0]?.text).toMatch(/celebration channel/);
    expect(await getPostByEventId(db, eventId)).toBeNull();
  });
});
