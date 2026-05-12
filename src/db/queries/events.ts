import type { Db } from '@/db/client';
import { events } from '@/db/schema';

export type Event = {
  id: string;
  workspaceId: string;
  personId: string;
  kind: 'birthday' | 'anniversary';
  eventDate: string;
  years: number | null;
  status: string;
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
  status: row.status,
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
