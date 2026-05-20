import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { approvals, events, people, suggestions, workspaces } from '@/db/schema';
import type { Approval } from './approvals';
import type { Person } from './people';
import type { Suggestion } from './suggestions';
import type { Workspace } from './workspaces';

export type EventStatus = 'pending' | 'approved' | 'skipped' | 'posted' | 'cancelled';

export type Event = {
  id: string;
  workspaceId: string;
  personId: string;
  kind: 'birthday' | 'anniversary';
  eventDate: string;
  years: number | null;
  status: EventStatus;
  approvalDmChannelId: string | null;
  approvalDmTs: string | null;
  detectedAt: Date;
};

export type NewEventInput = {
  workspaceId: string;
  personId: string;
  kind: 'birthday' | 'anniversary';
  eventDate: string; // YYYY-MM-DD
  years: number | null;
};

const toEvent = (row: typeof events.$inferSelect): Event => ({
  id: row.id,
  workspaceId: row.workspaceId,
  personId: row.personId,
  kind: row.kind as 'birthday' | 'anniversary',
  eventDate: row.eventDate,
  years: row.years,
  status: row.status as EventStatus,
  approvalDmChannelId: row.approvalDmChannelId,
  approvalDmTs: row.approvalDmTs,
  detectedAt: row.detectedAt,
});

// Bulk insert with ON CONFLICT DO NOTHING on the dedup key. Postgres'
// `RETURNING` after `DO NOTHING` only emits rows that were actually inserted,
// so the returned array is exactly the set of newly-created events. Idempotent
// by construction — re-running the same scan returns [].
export const findOrCreateEvents = async (db: Db, candidates: NewEventInput[]): Promise<Event[]> => {
  if (candidates.length === 0) return [];
  const result = await db
    .insert(events)
    .values(candidates)
    .onConflictDoNothing({
      target: [events.workspaceId, events.personId, events.kind, events.eventDate],
    })
    .returning();
  return result.map(toEvent);
};

export const getEventById = async (db: Db, eventId: string): Promise<Event | null> => {
  const rows = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  const row = rows[0];
  return row ? toEvent(row) : null;
};

export const updateEventStatus = async (
  db: Db,
  eventId: string,
  status: EventStatus,
): Promise<void> => {
  await db.update(events).set({ status }).where(eq(events.id, eventId));
};

// Stash the approval DM's channel + ts so a later approve/skip/modify tap can
// chat.update in place. Called from generate-suggestions right after the DM is
// posted.
export const setEventApprovalMessage = async (
  db: Db,
  eventId: string,
  channelId: string,
  ts: string,
): Promise<void> => {
  await db
    .update(events)
    .set({ approvalDmChannelId: channelId, approvalDmTs: ts })
    .where(eq(events.id, eventId));
};

// One-shot loader used by handlers and jobs. Returns null if the event is
// gone. `approval` is null until the admin acts; `suggestions` may be empty
// before the generate-suggestions job runs.
export type EventBundle = {
  event: Event;
  person: Person;
  workspace: Workspace;
  suggestions: Suggestion[];
  approval: Approval | null;
};

export const getEventForApproval = async (db: Db, eventId: string): Promise<EventBundle | null> => {
  const baseRows = await db
    .select({ event: events, person: people, workspace: workspaces })
    .from(events)
    .innerJoin(people, eq(people.id, events.personId))
    .innerJoin(workspaces, eq(workspaces.id, events.workspaceId))
    .where(eq(events.id, eventId))
    .limit(1);
  const base = baseRows[0];
  if (!base) return null;

  const sugRows = await db.select().from(suggestions).where(eq(suggestions.eventId, eventId));

  const approvalRows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.eventId, eventId))
    .limit(1);
  const approvalRow = approvalRows[0];

  return {
    event: toEvent(base.event),
    person: {
      id: base.person.id,
      workspaceId: base.person.workspaceId,
      name: base.person.name,
      email: base.person.email,
      slackUserId: base.person.slackUserId,
      birthdayMonth: base.person.birthdayMonth,
      birthdayDay: base.person.birthdayDay,
      startDate: base.person.startDate,
      team: base.person.team,
      role: base.person.role,
      optedOut: base.person.optedOut,
    },
    workspace: {
      id: base.workspace.id,
      slackTeamId: base.workspace.slackTeamId,
      slackTeamName: base.workspace.slackTeamName,
      installedBySlackUser: base.workspace.installedBySlackUser,
      celebrationChannelId: base.workspace.celebrationChannelId,
      defaultBudgetCents: base.workspace.defaultBudgetCents,
      timezone: base.workspace.timezone,
      createdAt: base.workspace.createdAt,
      updatedAt: base.workspace.updatedAt,
    },
    suggestions: sugRows.map((r) => ({
      id: r.id,
      eventId: r.eventId,
      gestureSummary: r.gestureSummary,
      gestureDetails: r.gestureDetails as Record<string, unknown>,
      estimatedCostCents: r.estimatedCostCents,
      rank: r.rank,
      createdAt: r.createdAt,
    })),
    approval: approvalRow
      ? {
          id: approvalRow.id,
          eventId: approvalRow.eventId,
          approverUserId: approvalRow.approverUserId,
          chosenSuggestionId: approvalRow.chosenSuggestionId,
          customGestureText: approvalRow.customGestureText,
          approvedBudgetCents: approvalRow.approvedBudgetCents,
          decidedAt: approvalRow.decidedAt,
          decision: approvalRow.decision as Approval['decision'],
        }
      : null,
  };
};
