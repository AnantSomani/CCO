import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { approvals } from '@/db/schema';

export type ApprovalDecision = 'approved' | 'skipped' | 'modified';

export type Approval = {
  id: string;
  eventId: string;
  approverUserId: string;
  chosenSuggestionId: string | null;
  customGestureText: string | null;
  approvedBudgetCents: number | null;
  decidedAt: Date;
  decision: ApprovalDecision;
};

export type NewApprovalInput = {
  eventId: string;
  approverUserId: string;
  decision: ApprovalDecision;
  chosenSuggestionId?: string | null;
  customGestureText?: string | null;
  approvedBudgetCents?: number | null;
};

const toApproval = (row: typeof approvals.$inferSelect): Approval => ({
  id: row.id,
  eventId: row.eventId,
  approverUserId: row.approverUserId,
  chosenSuggestionId: row.chosenSuggestionId,
  customGestureText: row.customGestureText,
  approvedBudgetCents: row.approvedBudgetCents,
  decidedAt: row.decidedAt,
  decision: row.decision as ApprovalDecision,
});

// Idempotent insert via the unique constraint on event_id. Returns null when
// an approval already exists for this event — callers treat that as "already
// decided, no-op."
export const insertApproval = async (db: Db, input: NewApprovalInput): Promise<Approval | null> => {
  const rows = await db
    .insert(approvals)
    .values({
      eventId: input.eventId,
      approverUserId: input.approverUserId,
      chosenSuggestionId: input.chosenSuggestionId ?? null,
      customGestureText: input.customGestureText ?? null,
      approvedBudgetCents: input.approvedBudgetCents ?? null,
      decision: input.decision,
    })
    .onConflictDoNothing({ target: approvals.eventId })
    .returning();
  const row = rows[0];
  return row ? toApproval(row) : null;
};

export const getApprovalByEventId = async (db: Db, eventId: string): Promise<Approval | null> => {
  const rows = await db.select().from(approvals).where(eq(approvals.eventId, eventId)).limit(1);
  const row = rows[0];
  return row ? toApproval(row) : null;
};
