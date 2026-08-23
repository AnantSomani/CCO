import { and, asc, eq, inArray, lt, lte } from 'drizzle-orm';
import {
  type AgentArtifactKind,
  type AgentArtifactStatus,
  type AgentSessionStatus,
  type ArtifactSlots,
  formatArtifactSummary,
  MAX_SESSION_TURNS,
  missingSlotsFor,
  parseArtifactSlots,
  SESSION_TTL_MS,
} from '@/agent/session-types';
import type { Db } from '@/db/client';
import { agentArtifacts, agentSessions, agentSessionTurns } from '@/db/schema';

export type AgentSession = {
  id: string;
  workspaceId: string;
  slackUserId: string;
  channelId: string | null;
  threadTs: string | null;
  status: AgentSessionStatus;
  expiresAt: Date;
  lastUserMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentSessionTurn = {
  id: string;
  sessionId: string;
  workspaceId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: Date;
};

export type AgentArtifact = {
  id: string;
  sessionId: string;
  workspaceId: string;
  kind: AgentArtifactKind;
  status: AgentArtifactStatus;
  slots: ArtifactSlots;
  missingSlots: string[];
  fireAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const OPEN_SESSION_STATUSES = ['active', 'waiting_for_user', 'pending_approval'] as const;
const OPEN_ARTIFACT_STATUSES = ['collecting', 'ready', 'pending_approval', 'scheduled'] as const;

const toSession = (row: typeof agentSessions.$inferSelect): AgentSession => ({
  ...row,
  status: row.status as AgentSessionStatus,
});

const toTurn = (row: typeof agentSessionTurns.$inferSelect): AgentSessionTurn => ({
  ...row,
  role: row.role as AgentSessionTurn['role'],
});

const toArtifact = (row: typeof agentArtifacts.$inferSelect): AgentArtifact => {
  const kind = row.kind as AgentArtifactKind;
  const slots = parseArtifactSlots(kind, row.slots) ?? {};
  return {
    ...row,
    kind,
    status: row.status as AgentArtifactStatus,
    slots,
    missingSlots: row.missingSlots ?? missingSlotsFor(kind, slots),
  };
};

const extendExpiry = (from = new Date()): Date => new Date(from.getTime() + SESSION_TTL_MS);

export const expireStaleSessions = async (db: Db, now = new Date()): Promise<number> => {
  const expired = await db
    .update(agentSessions)
    .set({ status: 'closed', updatedAt: now })
    .where(
      and(
        inArray(agentSessions.status, [...OPEN_SESSION_STATUSES]),
        lte(agentSessions.expiresAt, now),
      ),
    )
    .returning({ id: agentSessions.id });
  if (expired.length === 0) return 0;
  await db
    .update(agentArtifacts)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        inArray(
          agentArtifacts.sessionId,
          expired.map((row) => row.id),
        ),
        inArray(agentArtifacts.status, ['collecting', 'ready', 'pending_approval']),
      ),
    );
  return expired.length;
};

export const getOpenSession = async (
  db: Db,
  workspaceId: string,
  slackUserId: string,
  now = new Date(),
): Promise<AgentSession | null> => {
  await expireStaleSessions(db, now);
  const rows = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.slackUserId, slackUserId),
        inArray(agentSessions.status, [...OPEN_SESSION_STATUSES]),
      ),
    )
    .limit(1);
  return rows[0] ? toSession(rows[0]) : null;
};

export const getSessionById = async (
  db: Db,
  sessionId: string,
  workspaceId: string,
): Promise<AgentSession | null> => {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ? toSession(rows[0]) : null;
};

export const getSessionByThread = async (
  db: Db,
  workspaceId: string,
  slackUserId: string,
  threadTs: string,
): Promise<AgentSession | null> => {
  await expireStaleSessions(db);
  const rows = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.slackUserId, slackUserId),
        eq(agentSessions.threadTs, threadTs),
        inArray(agentSessions.status, [...OPEN_SESSION_STATUSES]),
      ),
    )
    .limit(1);
  return rows[0] ? toSession(rows[0]) : null;
};

export const getOrCreateOpenSession = async (
  db: Db,
  input: {
    workspaceId: string;
    slackUserId: string;
    channelId?: string | null;
    threadTs?: string | null;
  },
  now = new Date(),
): Promise<AgentSession> => {
  const existing = await getOpenSession(db, input.workspaceId, input.slackUserId, now);
  if (existing) {
    const updated = await db
      .update(agentSessions)
      .set({
        lastUserMessageAt: now,
        expiresAt: extendExpiry(now),
        updatedAt: now,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      })
      .where(eq(agentSessions.id, existing.id))
      .returning();
    const row = updated[0];
    if (!row) throw new Error('failed to touch agent session');
    return toSession(row);
  }

  try {
    const inserted = await db
      .insert(agentSessions)
      .values({
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        channelId: input.channelId ?? null,
        threadTs: input.threadTs ?? null,
        status: 'active',
        expiresAt: extendExpiry(now),
        lastUserMessageAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('failed to create agent session');
    return toSession(row);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await getOpenSession(db, input.workspaceId, input.slackUserId, now);
    if (raced) return raced;
    throw error;
  }
};

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && error.code === '23505';
};

export const setSessionThread = async (
  db: Db,
  sessionId: string,
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<void> => {
  await db
    .update(agentSessions)
    .set({ channelId, threadTs, updatedAt: new Date() })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.workspaceId, workspaceId)));
};

export const setSessionStatus = async (
  db: Db,
  sessionId: string,
  workspaceId: string,
  status: AgentSessionStatus,
): Promise<void> => {
  await db
    .update(agentSessions)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.workspaceId, workspaceId)));
};

export const closeSession = async (
  db: Db,
  sessionId: string,
  workspaceId: string,
): Promise<AgentSession | null> => {
  const now = new Date();
  const rows = await db
    .update(agentSessions)
    .set({ status: 'closed', updatedAt: now })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.workspaceId, workspaceId)))
    .returning();
  await db
    .update(agentArtifacts)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(agentArtifacts.sessionId, sessionId),
        eq(agentArtifacts.workspaceId, workspaceId),
        inArray(agentArtifacts.status, ['collecting', 'ready', 'pending_approval']),
      ),
    );
  return rows[0] ? toSession(rows[0]) : null;
};

export const appendSessionTurn = async (
  db: Db,
  input: {
    sessionId: string;
    workspaceId: string;
    role: AgentSessionTurn['role'];
    text: string;
  },
): Promise<AgentSessionTurn> => {
  const inserted = await db
    .insert(agentSessionTurns)
    .values({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      role: input.role,
      text: input.text,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('failed to append session turn');

  const extras = await db
    .select({ id: agentSessionTurns.id })
    .from(agentSessionTurns)
    .where(
      and(
        eq(agentSessionTurns.sessionId, input.sessionId),
        eq(agentSessionTurns.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(asc(agentSessionTurns.createdAt));
  const overflow = extras.slice(0, Math.max(0, extras.length - MAX_SESSION_TURNS));
  if (overflow.length > 0) {
    await db.delete(agentSessionTurns).where(
      inArray(
        agentSessionTurns.id,
        overflow.map((turn) => turn.id),
      ),
    );
  }
  return toTurn(row);
};

export const listRecentTurns = async (
  db: Db,
  sessionId: string,
  workspaceId: string,
): Promise<AgentSessionTurn[]> => {
  const rows = await db
    .select()
    .from(agentSessionTurns)
    .where(
      and(
        eq(agentSessionTurns.sessionId, sessionId),
        eq(agentSessionTurns.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(agentSessionTurns.createdAt))
    .limit(MAX_SESSION_TURNS);
  return rows.map(toTurn);
};

export const getOpenArtifact = async (
  db: Db,
  sessionId: string,
  workspaceId: string,
): Promise<AgentArtifact | null> => {
  const rows = await db
    .select()
    .from(agentArtifacts)
    .where(
      and(
        eq(agentArtifacts.sessionId, sessionId),
        eq(agentArtifacts.workspaceId, workspaceId),
        inArray(agentArtifacts.status, [...OPEN_ARTIFACT_STATUSES]),
      ),
    )
    .limit(1);
  return rows[0] ? toArtifact(rows[0]) : null;
};

export const getArtifactById = async (
  db: Db,
  artifactId: string,
  workspaceId: string,
): Promise<AgentArtifact | null> => {
  const rows = await db
    .select()
    .from(agentArtifacts)
    .where(and(eq(agentArtifacts.id, artifactId), eq(agentArtifacts.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ? toArtifact(rows[0]) : null;
};

export const upsertOpenArtifact = async (
  db: Db,
  input: {
    sessionId: string;
    workspaceId: string;
    kind: AgentArtifactKind;
    slots?: ArtifactSlots;
  },
): Promise<AgentArtifact> => {
  const existing = await getOpenArtifact(db, input.sessionId, input.workspaceId);
  const slots = parseArtifactSlots(input.kind, input.slots ?? {}) ?? {};
  const missingSlots = missingSlotsFor(input.kind, slots);
  const now = new Date();
  if (existing && existing.kind === input.kind) {
    const merged = { ...existing.slots, ...slots };
    const updated = await db
      .update(agentArtifacts)
      .set({
        slots: merged,
        missingSlots: missingSlotsFor(input.kind, merged),
        status: missingSlotsFor(input.kind, merged).length === 0 ? 'ready' : 'collecting',
        updatedAt: now,
        expiresAt: extendExpiry(now),
      })
      .where(
        and(eq(agentArtifacts.id, existing.id), eq(agentArtifacts.workspaceId, input.workspaceId)),
      )
      .returning();
    const row = updated[0];
    if (!row) throw new Error('failed to update artifact');
    return toArtifact(row);
  }
  if (existing) {
    await db
      .update(agentArtifacts)
      .set({ status: 'cancelled', updatedAt: now })
      .where(
        and(eq(agentArtifacts.id, existing.id), eq(agentArtifacts.workspaceId, input.workspaceId)),
      );
  }
  const inserted = await db
    .insert(agentArtifacts)
    .values({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      status: missingSlots.length === 0 ? 'ready' : 'collecting',
      slots,
      missingSlots,
      expiresAt: extendExpiry(now),
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('failed to create artifact');
  return toArtifact(row);
};

export const mergeArtifactSlots = async (
  db: Db,
  input: {
    artifactId: string;
    workspaceId: string;
    slots: ArtifactSlots;
  },
): Promise<AgentArtifact | null> => {
  const existing = await getArtifactById(db, input.artifactId, input.workspaceId);
  if (!existing) return null;
  if (!['collecting', 'ready'].includes(existing.status)) return existing;
  const merged = { ...existing.slots, ...input.slots };
  const parsed = parseArtifactSlots(existing.kind, merged);
  if (!parsed) return null;
  const missingSlots = missingSlotsFor(existing.kind, parsed);
  const now = new Date();
  const fireAt =
    existing.kind === 'reminder' && typeof parsed.fireAt === 'string'
      ? new Date(parsed.fireAt)
      : existing.fireAt;
  const updated = await db
    .update(agentArtifacts)
    .set({
      slots: parsed,
      missingSlots,
      status: missingSlots.length === 0 ? 'ready' : 'collecting',
      fireAt,
      updatedAt: now,
      expiresAt: extendExpiry(now),
    })
    .where(
      and(eq(agentArtifacts.id, existing.id), eq(agentArtifacts.workspaceId, input.workspaceId)),
    )
    .returning();
  return updated[0] ? toArtifact(updated[0]) : null;
};

export const setArtifactStatus = async (
  db: Db,
  artifactId: string,
  workspaceId: string,
  status: AgentArtifactStatus,
  extras?: { fireAt?: Date | null },
): Promise<AgentArtifact | null> => {
  const rows = await db
    .update(agentArtifacts)
    .set({
      status,
      updatedAt: new Date(),
      ...(extras?.fireAt !== undefined ? { fireAt: extras.fireAt } : {}),
    })
    .where(and(eq(agentArtifacts.id, artifactId), eq(agentArtifacts.workspaceId, workspaceId)))
    .returning();
  return rows[0] ? toArtifact(rows[0]) : null;
};

export const cancelOpenArtifacts = async (
  db: Db,
  sessionId: string,
  workspaceId: string,
): Promise<number> => {
  const rows = await db
    .update(agentArtifacts)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(agentArtifacts.sessionId, sessionId),
        eq(agentArtifacts.workspaceId, workspaceId),
        inArray(agentArtifacts.status, ['collecting', 'ready', 'pending_approval']),
      ),
    )
    .returning({ id: agentArtifacts.id });
  return rows.length;
};

export const claimDueReminder = async (
  db: Db,
  artifactId: string,
  workspaceId: string,
  now = new Date(),
): Promise<AgentArtifact | null> => {
  const rows = await db
    .update(agentArtifacts)
    .set({ status: 'completed', updatedAt: now })
    .where(
      and(
        eq(agentArtifacts.id, artifactId),
        eq(agentArtifacts.workspaceId, workspaceId),
        eq(agentArtifacts.kind, 'reminder'),
        eq(agentArtifacts.status, 'scheduled'),
        lte(agentArtifacts.fireAt, now),
      ),
    )
    .returning();
  return rows[0] ? toArtifact(rows[0]) : null;
};

export const listDueReminders = async (db: Db, now = new Date()): Promise<AgentArtifact[]> => {
  const rows = await db
    .select()
    .from(agentArtifacts)
    .where(
      and(
        eq(agentArtifacts.kind, 'reminder'),
        eq(agentArtifacts.status, 'scheduled'),
        lte(agentArtifacts.fireAt, now),
      ),
    );
  return rows.map(toArtifact);
};

export const deleteClosedSessionsBefore = async (db: Db, before: Date): Promise<number> => {
  const rows = await db
    .delete(agentSessions)
    .where(and(eq(agentSessions.status, 'closed'), lt(agentSessions.updatedAt, before)))
    .returning({ id: agentSessions.id });
  return rows.length;
};

export const conversationText = (turns: AgentSessionTurn[], currentText: string): string =>
  [...turns.map((turn) => turn.text), currentText].join('\n');

export const summarizeArtifact = (artifact: AgentArtifact | null): string =>
  formatArtifactSummary(artifact);

export const sessionOwnerMatch = (
  session: AgentSession,
  workspaceId: string,
  slackUserId: string,
): boolean => session.workspaceId === workspaceId && session.slackUserId === slackUserId;
