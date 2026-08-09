import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { users } from '@/db/schema';

export type User = {
  id: string;
  workspaceId: string;
  slackUserId: string;
  email: string | null;
  name: string | null;
  isAdmin: boolean;
  createdAt: Date;
};

type UpsertUserInput = {
  workspaceId: string;
  slackUserId: string;
  email?: string | null;
  name?: string | null;
  isAdmin?: boolean;
};

const toUser = (row: typeof users.$inferSelect): User => ({
  id: row.id,
  workspaceId: row.workspaceId,
  slackUserId: row.slackUserId,
  email: row.email,
  name: row.name,
  isAdmin: row.isAdmin,
  createdAt: row.createdAt,
});

export const upsertUser = async (db: Db, input: UpsertUserInput): Promise<User> => {
  const rows = await db
    .insert(users)
    .values({
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId,
      email: input.email ?? null,
      name: input.name ?? null,
      isAdmin: input.isAdmin ?? false,
    })
    .onConflictDoUpdate({
      target: [users.workspaceId, users.slackUserId],
      set: {
        email: input.email ?? null,
        name: input.name ?? null,
        ...(input.isAdmin === undefined ? {} : { isAdmin: input.isAdmin }),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertUser returned no row');
  return toUser(row);
};

export const getUserBySlackUserId = async (
  db: Db,
  workspaceId: string,
  slackUserId: string,
): Promise<User | null> => {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.workspaceId, workspaceId), eq(users.slackUserId, slackUserId)))
    .limit(1);
  const row = rows[0];
  return row ? toUser(row) : null;
};

export const isWorkspaceAdmin = async (
  db: Db,
  workspaceId: string,
  slackUserId: string,
): Promise<boolean> => {
  const user = await getUserBySlackUserId(db, workspaceId, slackUserId);
  return user?.isAdmin === true;
};
