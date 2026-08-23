import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { findOrCreateEvents } from '@/db/queries/events';
import { upsertPeople } from '@/db/queries/people';
import {
  findMostRecentUnloggedPostForWorkspace,
  getPostByEventId,
  insertPost,
} from '@/db/queries/posts';
import { upsertUser } from '@/db/queries/users';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { people } from '@/db/schema';
import { handleMessageIm } from '@/slack/handlers/messages';
import { createTestDb } from './db';
import {
  type RecordingSlackClient,
  recordingEmitter,
  recordingSlackClientFactory,
} from './slack-stub';

const messageCtx = (
  db: Db,
  slack: RecordingSlackClient,
  events: Array<{ name: string; data: Record<string, unknown> }> = [],
) => ({
  db,
  getSlackClient: recordingSlackClientFactory(slack),
  emitter: recordingEmitter(events),
});

const setupAdminWithPostedEvent = async (db: Db) => {
  const slackTeamId = `T_${Math.random().toString(36).slice(2, 10)}`;
  const ws = await upsertWorkspace(db, {
    slackTeamId,
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
  // Wire Alice to a Slack user so opt-out tests can find her.
  await db.update(people).set({ slackUserId: 'U_ALICE' }).where(eq(people.id, person.id));
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
  const post = await insertPost(db, {
    eventId: ev.id,
    channelId: 'C_CHAN',
    slackTs: '999.111',
    threadTs: '999.111',
  });
  if (!post) throw new Error('seed post missing');
  return { workspaceId: ws.id, slackTeamId, postId: post.id };
};

describe('handleMessageIm', () => {
  it('logs spend when admin DMs a dollar amount and there is an unlogged post', async () => {
    const db = await createTestDb();
    const { slackTeamId, postId } = await setupAdminWithPostedEvent(db);
    const slack: RecordingSlackClient = {};
    const result = await handleMessageIm(messageCtx(db, slack), slackTeamId, {
      user: 'U_ADMIN',
      text: '45',
      ts: 'm1',
    });
    expect(result.ok && result.value.kind).toBe('spend_logged');
    const post = await getPostByEventId(db, (await db.query.events.findFirst())?.id ?? '');
    expect(post?.actualSpendCents).toBe(4500);
    expect(slack.posts?.[0]?.text).toMatch(/Logged \$45/);
    expect(postId).toBe(post?.id);
  });

  it('parses "$45.50" → 4550 cents', async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    const result = await handleMessageIm(messageCtx(db, {}), slackTeamId, {
      user: 'U_ADMIN',
      text: '$45.50',
      ts: 'm1',
    });
    expect(result.ok && result.value.kind).toBe('spend_logged');
  });

  it('does not treat non-numeric replies as spend logging', async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    const slack: RecordingSlackClient = {};
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const result = await handleMessageIm(messageCtx(db, slack, events), slackTeamId, {
      user: 'U_ADMIN',
      text: 'forty-five',
      ts: 'm1',
    });
    expect(result.ok && result.value.kind).toBe('agent_queued');
    expect(events).toHaveLength(1);
    const post = await findMostRecentUnloggedPostForWorkspace(
      db,
      (await db.query.workspaces.findFirst())?.id ?? '',
    );
    expect(post?.actualSpendCents ?? null).toBeNull();
  });

  it('handles `skip my birthday` for a person on the roster', async () => {
    const db = await createTestDb();
    const { workspaceId, slackTeamId } = await setupAdminWithPostedEvent(db);
    const slack: RecordingSlackClient = {};
    const result = await handleMessageIm(messageCtx(db, slack), slackTeamId, {
      user: 'U_ALICE',
      text: 'skip my birthday',
      ts: 'm1',
    });
    expect(result.ok && result.value.kind).toBe('opted_out');
    const alice = await db.query.people.findFirst({
      where: eq(people.slackUserId, 'U_ALICE'),
    });
    expect(alice?.optedOut).toBe(true);
    expect(slack.posts?.[0]?.text).toMatch(/opted out/);
    expect(workspaceId).toBeTruthy();
  });

  it('handles `include my birthday` to reverse opt-out', async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    await db.update(people).set({ optedOut: true }).where(eq(people.slackUserId, 'U_ALICE'));
    const slack: RecordingSlackClient = {};
    const result = await handleMessageIm(messageCtx(db, slack), slackTeamId, {
      user: 'U_ALICE',
      text: 'include my birthday',
      ts: 'm1',
    });
    expect(result.ok && result.value.kind).toBe('opted_in');
    const alice = await db.query.people.findFirst({
      where: eq(people.slackUserId, 'U_ALICE'),
    });
    expect(alice?.optedOut).toBe(false);
  });

  it("ignores the bot's own messages", async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    const slack: RecordingSlackClient = {};
    const result = await handleMessageIm(messageCtx(db, slack), slackTeamId, {
      user: 'U_ADMIN',
      text: '45',
      ts: 'm1',
      bot_id: 'B1',
    });
    expect(result.ok && result.value.kind).toBe('ignored');
    expect(slack.posts ?? []).toHaveLength(0);
  });

  it('ignores thread replies', async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    const result = await handleMessageIm(messageCtx(db, {}), slackTeamId, {
      user: 'U_ADMIN',
      text: '45',
      ts: 'm1',
      thread_ts: 'parent',
    });
    expect(result.ok && result.value.kind).toBe('ignored');
  });

  it('falls back to help reply for unrelated text from a non-admin not on roster', async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    const slack: RecordingSlackClient = {};
    // Use a fresh slack user not on people or users.
    const result = await handleMessageIm(messageCtx(db, slack), slackTeamId, {
      user: 'U_RANDOM',
      text: 'hi there',
      ts: 'm1',
    });
    expect(result.ok && result.value.kind).toBe('help');
    expect(slack.posts?.[0]?.text).toMatch(/I'm Confetti/);
  });

  it('replies "couldn\'t find you" when a non-roster user tries to opt out', async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    const slack: RecordingSlackClient = {};
    const result = await handleMessageIm(messageCtx(db, slack), slackTeamId, {
      user: 'U_NOTONROSTER',
      text: 'skip my birthday',
      ts: 'm1',
    });
    expect(result.ok && result.value.kind).toBe('opt_no_match');
    expect(slack.posts?.[0]?.text).toMatch(/couldn't find you/);
  });

  it('does not log spend when there is no unlogged post (falls back to help)', async () => {
    const db = await createTestDb();
    const { slackTeamId, workspaceId } = await setupAdminWithPostedEvent(db);
    // Log the existing post first so there's nothing unlogged.
    const unlogged = await findMostRecentUnloggedPostForWorkspace(db, workspaceId);
    if (!unlogged) throw new Error('seed unlogged missing');
    const { updatePostSpend } = await import('@/db/queries/posts');
    await updatePostSpend(db, unlogged.id, 1000);
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const result = await handleMessageIm(messageCtx(db, {}, events), slackTeamId, {
      user: 'U_ADMIN',
      text: '45',
      ts: 'm1',
    });
    expect(result.ok && result.value.kind).toBe('agent_queued');
    expect(events).toHaveLength(1);
  });

  it('logs spend `45` even when an agent session is already open', async () => {
    const db = await createTestDb();
    const { slackTeamId, workspaceId } = await setupAdminWithPostedEvent(db);
    const { getOrCreateOpenSession } = await import('@/db/queries/agent-sessions');
    await getOrCreateOpenSession(db, {
      workspaceId,
      slackUserId: 'U_ADMIN',
    });
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const result = await handleMessageIm(messageCtx(db, {}, events), slackTeamId, {
      user: 'U_ADMIN',
      text: '45',
      ts: 'm-spend-conflict',
    });
    expect(result.ok && result.value.kind).toBe('spend_logged');
    expect(events).toHaveLength(0);
  });

  it('continues an admin DM into the active agent session', async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const first = await handleMessageIm(messageCtx(db, {}, events), slackTeamId, {
      user: 'U_ADMIN',
      text: 'plan pizza for August 22nd',
      ts: 'm-date',
    });
    const second = await handleMessageIm(messageCtx(db, {}, events), slackTeamId, {
      user: 'U_ADMIN',
      text: '7pm',
      ts: 'm-time',
    });
    expect(first.ok && first.value.kind).toBe('agent_queued');
    expect(second.ok && second.value.kind).toBe('agent_queued');
    expect(events).toHaveLength(2);
  });

  it('continues a matching agent thread reply and ignores other threads', async () => {
    const db = await createTestDb();
    const { slackTeamId, workspaceId } = await setupAdminWithPostedEvent(db);
    const { getOrCreateOpenSession, setSessionThread } = await import(
      '@/db/queries/agent-sessions'
    );
    const session = await getOrCreateOpenSession(db, {
      workspaceId,
      slackUserId: 'U_ADMIN',
    });
    await setSessionThread(db, session.id, workspaceId, 'D_ADMIN', 'thread.1');
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const continued = await handleMessageIm(messageCtx(db, {}, events), slackTeamId, {
      user: 'U_ADMIN',
      text: '7pm',
      ts: 'm-thread',
      thread_ts: 'thread.1',
    });
    const ignored = await handleMessageIm(messageCtx(db, {}, events), slackTeamId, {
      user: 'U_ADMIN',
      text: '7pm',
      ts: 'm-other',
      thread_ts: 'other.thread',
    });
    expect(continued.ok && continued.value.kind).toBe('agent_queued');
    expect(ignored.ok && ignored.value.kind).toBe('ignored');
  });

  it('does not continue sessions for non-admin users', async () => {
    const db = await createTestDb();
    const { slackTeamId } = await setupAdminWithPostedEvent(db);
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const result = await handleMessageIm(messageCtx(db, {}, events), slackTeamId, {
      user: 'U_ALICE',
      text: 'August 22nd',
      ts: 'm-member',
    });
    expect(result.ok && result.value.kind).toBe('help');
    expect(events).toHaveLength(0);
  });
});
