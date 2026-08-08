import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { people } from '@/db/schema';

export type Person = {
  id: string;
  workspaceId: string;
  name: string;
  email: string;
  slackUserId: string | null;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  startDate: string | null;
  team: string | null;
  role: string | null;
  optedOut: boolean;
};

export type UpsertPeopleRow = {
  name: string;
  email: string;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  startDate: Date | null;
  team: string | null;
  role: string | null;
};

export type UpsertPeopleCounts = { inserted: number; updated: number };

const formatStartDate = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

// Bulk upsert by (workspace_id, email). Uses Postgres' xmax = 0 trick to
// distinguish freshly-inserted rows from rows that hit ON CONFLICT and were
// updated. Preserves opted_out and slack_user_id across re-uploads — the CSV
// is treated as the source of truth for name/birthday/start_date/team/role
// only.
export const upsertPeople = async (
  db: Db,
  workspaceId: string,
  rows: UpsertPeopleRow[],
): Promise<UpsertPeopleCounts> => {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const now = new Date();
  const values = rows.map((r) => ({
    workspaceId,
    name: r.name,
    email: r.email,
    birthdayMonth: r.birthdayMonth,
    birthdayDay: r.birthdayDay,
    startDate: formatStartDate(r.startDate),
    team: r.team,
    role: r.role,
  }));

  const result = await db
    .insert(people)
    .values(values)
    .onConflictDoUpdate({
      target: [people.workspaceId, people.email],
      set: {
        name: sql`excluded.name`,
        birthdayMonth: sql`excluded.birthday_month`,
        birthdayDay: sql`excluded.birthday_day`,
        startDate: sql`excluded.start_date`,
        team: sql`excluded.team`,
        role: sql`excluded.role`,
        updatedAt: now,
      },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });

  let inserted = 0;
  for (const row of result) if (row.inserted) inserted++;
  return { inserted, updated: result.length - inserted };
};

const toPerson = (row: typeof people.$inferSelect): Person => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  email: row.email,
  slackUserId: row.slackUserId,
  birthdayMonth: row.birthdayMonth,
  birthdayDay: row.birthdayDay,
  startDate: row.startDate,
  team: row.team,
  role: row.role,
  optedOut: row.optedOut,
});

// ─── dashboard roster management ─────────────────────────────────────────────
// CRUD for the admin dashboard. Every query is scoped by workspaceId so an
// admin can never read or mutate another workspace's roster, even if a stale
// person id is submitted.

export type PersonWrite = {
  name: string;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  startDate: string | null; // YYYY-MM-DD, or null
  team: string | null;
  role: string | null;
};

// Whole roster, opted-out included (the dashboard shows and toggles opt-out
// state, so unlike the celebration queries it must not filter it out).
export const listPeople = async (db: Db, workspaceId: string): Promise<Person[]> => {
  const rows = await db
    .select()
    .from(people)
    .where(eq(people.workspaceId, workspaceId))
    .orderBy(people.name);
  return rows.map(toPerson);
};

// Returns the new person, or null if the email already exists in this
// workspace (the (workspace_id, email) unique constraint). Null lets the
// action layer surface a friendly "already on the roster" message instead of
// a 500.
export const insertPerson = async (
  db: Db,
  workspaceId: string,
  email: string,
  fields: PersonWrite,
): Promise<Person | null> => {
  const rows = await db
    .insert(people)
    .values({ workspaceId, email, ...fields })
    .onConflictDoNothing({ target: [people.workspaceId, people.email] })
    .returning();
  const row = rows[0];
  return row ? toPerson(row) : null;
};

// Updates the mutable fields of a person by id, scoped to the workspace.
// Email is intentionally not updatable here (it is the identity key). Returns
// null when no row matches (unknown or cross-workspace id).
export const updatePerson = async (
  db: Db,
  workspaceId: string,
  personId: string,
  fields: PersonWrite,
): Promise<Person | null> => {
  const rows = await db
    .update(people)
    .set({ ...fields, updatedAt: new Date() })
    .where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId)))
    .returning();
  const row = rows[0];
  return row ? toPerson(row) : null;
};

// Hard delete (CONVENTIONS: no soft delete in v1). FK cascades remove any
// events/suggestions for this person. Returns false when nothing matched.
export const deletePerson = async (
  db: Db,
  workspaceId: string,
  personId: string,
): Promise<boolean> => {
  const rows = await db
    .delete(people)
    .where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId)))
    .returning({ id: people.id });
  return rows.length > 0;
};

// Sets opt-out state by person id (the dashboard equivalent of the
// slack-user-id variant used by the DM handler). Returns false when nothing
// matched.
export const setOptedOutById = async (
  db: Db,
  workspaceId: string,
  personId: string,
  optedOut: boolean,
): Promise<boolean> => {
  const rows = await db
    .update(people)
    .set({ optedOut, updatedAt: new Date() })
    .where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId)))
    .returning({ id: people.id });
  return rows.length > 0;
};

// Opt-out filter lives at the query layer (Architecture invariant #8):
// callers can't accidentally include opted-out people.
export const findBirthdayCandidates = async (
  db: Db,
  workspaceId: string,
  month: number,
  day: number,
): Promise<Person[]> => {
  const rows = await db
    .select()
    .from(people)
    .where(
      and(
        eq(people.workspaceId, workspaceId),
        eq(people.optedOut, false),
        eq(people.birthdayMonth, month),
        eq(people.birthdayDay, day),
      ),
    );
  return rows.map(toPerson);
};

export const findPersonBySlackUserId = async (
  db: Db,
  workspaceId: string,
  slackUserId: string,
): Promise<Person | null> => {
  const rows = await db
    .select()
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.slackUserId, slackUserId)))
    .limit(1);
  const row = rows[0];
  return row ? toPerson(row) : null;
};

// Toggles opted_out for a person matched by slack_user_id. Returns the new
// state, or null if no matching person exists (e.g. admin DMs us but their
// email isn't on the roster yet). Treats "no match" distinctly from "no
// change" so the message handler can reply appropriately.
export const setOptedOutBySlackUser = async (
  db: Db,
  workspaceId: string,
  slackUserId: string,
  optedOut: boolean,
): Promise<{ personId: string; name: string } | null> => {
  const rows = await db
    .update(people)
    .set({ optedOut, updatedAt: new Date() })
    .where(and(eq(people.workspaceId, workspaceId), eq(people.slackUserId, slackUserId)))
    .returning({ id: people.id, name: people.name });
  const row = rows[0];
  return row ? { personId: row.id, name: row.name } : null;
};

export const listOptedOut = async (
  db: Db,
  workspaceId: string,
): Promise<Array<{ name: string; email: string }>> => {
  const rows = await db
    .select({ name: people.name, email: people.email })
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.optedOut, true)));
  return rows;
};

// Anniversary candidates: month/day match AND start_date strictly before today
// (someone who started today is not yet at their first anniversary). Both
// filters at the query layer so callers can't forget the start_date < today
// guard.
export const findAnniversaryCandidates = async (
  db: Db,
  workspaceId: string,
  month: number,
  day: number,
  todayDate: string, // YYYY-MM-DD
): Promise<Person[]> => {
  const rows = await db
    .select()
    .from(people)
    .where(
      and(
        eq(people.workspaceId, workspaceId),
        eq(people.optedOut, false),
        sql`EXTRACT(MONTH FROM ${people.startDate}) = ${month}`,
        sql`EXTRACT(DAY FROM ${people.startDate}) = ${day}`,
        sql`${people.startDate} < ${todayDate}::date`,
      ),
    );
  return rows.map(toPerson);
};
