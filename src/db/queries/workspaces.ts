import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { workspaces } from '@/db/schema';
import { decrypt, encrypt } from '@/lib/crypto';

// Plain (no-Drizzle-types) shape returned to callers. `botAccessTokenEnc` is
// intentionally omitted — see `getWorkspaceBotAccessToken` for the one path
// that returns plaintext token material.
export type Workspace = {
  id: string;
  slackTeamId: string;
  slackTeamName: string;
  installedBySlackUser: string;
  celebrationChannelId: string | null;
  defaultBudgetCents: number;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
};

type UpsertWorkspaceInput = {
  slackTeamId: string;
  slackTeamName: string;
  installedBySlackUser: string;
  botAccessToken: string; // PLAINTEXT — encrypted before write
};

const toWorkspace = (row: typeof workspaces.$inferSelect): Workspace => ({
  id: row.id,
  slackTeamId: row.slackTeamId,
  slackTeamName: row.slackTeamName,
  installedBySlackUser: row.installedBySlackUser,
  celebrationChannelId: row.celebrationChannelId,
  defaultBudgetCents: row.defaultBudgetCents,
  timezone: row.timezone,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

// Idempotent install: on conflict on slack_team_id, refresh the encrypted
// token and slack_team_name (in case the workspace was renamed). The uuid
// `id` is stable across reinstalls so downstream FKs (users, people, events)
// continue to point at the same workspace.
export const upsertWorkspace = async (db: Db, input: UpsertWorkspaceInput): Promise<Workspace> => {
  const botAccessTokenEnc = encrypt(input.botAccessToken);
  const now = new Date();
  const rows = await db
    .insert(workspaces)
    .values({
      slackTeamId: input.slackTeamId,
      slackTeamName: input.slackTeamName,
      installedBySlackUser: input.installedBySlackUser,
      botAccessTokenEnc,
    })
    .onConflictDoUpdate({
      target: workspaces.slackTeamId,
      set: {
        slackTeamName: input.slackTeamName,
        installedBySlackUser: input.installedBySlackUser,
        botAccessTokenEnc,
        updatedAt: now,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertWorkspace returned no row');
  return toWorkspace(row);
};

export const getWorkspaceById = async (db: Db, id: string): Promise<Workspace | null> => {
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  const row = rows[0];
  return row ? toWorkspace(row) : null;
};

export const getWorkspaceBySlackTeamId = async (
  db: Db,
  slackTeamId: string,
): Promise<Workspace | null> => {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slackTeamId, slackTeamId))
    .limit(1);
  const row = rows[0];
  return row ? toWorkspace(row) : null;
};

// Only function that returns plaintext token material. Callers must use the
// token immediately for a Slack API call and not persist or log it.
export const getWorkspaceBotAccessToken = async (
  db: Db,
  workspaceId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ enc: workspaces.botAccessTokenEnc })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return decrypt(row.enc);
};
