import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { events, people, posts } from '@/db/schema';

export type Post = {
  id: string;
  eventId: string;
  channelId: string;
  slackTs: string;
  threadTs: string | null;
  postedAt: Date;
  actualSpendCents: number | null;
  spendLoggedAt: Date | null;
};

export type NewPostInput = {
  eventId: string;
  channelId: string;
  slackTs: string;
  threadTs?: string | null;
};

const toPost = (row: typeof posts.$inferSelect): Post => ({
  id: row.id,
  eventId: row.eventId,
  channelId: row.channelId,
  slackTs: row.slackTs,
  threadTs: row.threadTs,
  postedAt: row.postedAt,
  actualSpendCents: row.actualSpendCents,
  spendLoggedAt: row.spendLoggedAt,
});

// Insert with the existing UNIQUE(event_id) acting as the idempotency guard.
// Returns null when a post already exists — the caller (day-of job) treats
// that as "already posted, skip."
export const insertPost = async (db: Db, input: NewPostInput): Promise<Post | null> => {
  const rows = await db
    .insert(posts)
    .values({
      eventId: input.eventId,
      channelId: input.channelId,
      slackTs: input.slackTs,
      threadTs: input.threadTs ?? null,
    })
    .onConflictDoNothing({ target: posts.eventId })
    .returning();
  const row = rows[0];
  return row ? toPost(row) : null;
};

export const updatePostSpend = async (db: Db, postId: string, cents: number): Promise<void> => {
  await db
    .update(posts)
    .set({ actualSpendCents: cents, spendLoggedAt: new Date() })
    .where(eq(posts.id, postId));
};

export const getPostByEventId = async (db: Db, eventId: string): Promise<Post | null> => {
  const rows = await db.select().from(posts).where(eq(posts.eventId, eventId)).limit(1);
  const row = rows[0];
  return row ? toPost(row) : null;
};

// Used by the spend-log message parser: given an admin's slack user id, find
// the most recently posted celebration that still has no logged spend AND
// where that admin is the workspace admin we DM'd. v1 is one admin per
// workspace, so we match on workspace membership only.
export const findMostRecentUnloggedPostForWorkspace = async (
  db: Db,
  workspaceId: string,
): Promise<Post | null> => {
  const rows = await db
    .select({ post: posts })
    .from(posts)
    .innerJoin(events, eq(events.id, posts.eventId))
    .where(and(eq(events.workspaceId, workspaceId), isNull(posts.actualSpendCents)))
    .orderBy(desc(posts.postedAt))
    .limit(1);
  const row = rows[0];
  return row ? toPost(row.post) : null;
};

// Used by the celebration post DM "Posted! Reply with what you spent." to
// resolve which person was celebrated when logging spend.
export const getPostWithPerson = async (
  db: Db,
  postId: string,
): Promise<{ post: Post; personName: string } | null> => {
  const rows = await db
    .select({ post: posts, name: people.name })
    .from(posts)
    .innerJoin(events, eq(events.id, posts.eventId))
    .innerJoin(people, eq(people.id, events.personId))
    .where(eq(posts.id, postId))
    .limit(1);
  const row = rows[0];
  return row ? { post: toPost(row.post), personName: row.name } : null;
};
