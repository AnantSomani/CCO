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
