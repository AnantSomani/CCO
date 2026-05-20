import { asc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { suggestions } from '@/db/schema';

export type Suggestion = {
  id: string;
  eventId: string;
  gestureSummary: string;
  gestureDetails: Record<string, unknown>;
  estimatedCostCents: number;
  rank: number;
  createdAt: Date;
};

export type NewSuggestionInput = {
  gestureSummary: string;
  gestureDetails: Record<string, unknown>;
  estimatedCostCents: number;
  rank: number;
};

const toSuggestion = (row: typeof suggestions.$inferSelect): Suggestion => ({
  id: row.id,
  eventId: row.eventId,
  gestureSummary: row.gestureSummary,
  gestureDetails: row.gestureDetails as Record<string, unknown>,
  estimatedCostCents: row.estimatedCostCents,
  rank: row.rank,
  createdAt: row.createdAt,
});

// Bulk insert. Returns the inserted rows so callers can wire suggestion IDs
// into the approval DM's button values.
export const insertSuggestions = async (
  db: Db,
  eventId: string,
  rows: NewSuggestionInput[],
): Promise<Suggestion[]> => {
  if (rows.length === 0) return [];
  const result = await db
    .insert(suggestions)
    .values(rows.map((r) => ({ eventId, ...r })))
    .returning();
  return result.map(toSuggestion);
};

export const getSuggestionsByEventId = async (db: Db, eventId: string): Promise<Suggestion[]> => {
  const rows = await db
    .select()
    .from(suggestions)
    .where(eq(suggestions.eventId, eventId))
    .orderBy(asc(suggestions.rank));
  return rows.map(toSuggestion);
};
