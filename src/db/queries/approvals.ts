import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { approvals, events, suggestions } from '@/db/schema';

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

// Backs the agent's `list_recent_workspace_gestures` tool. Returns recently
// decided gestures (approved or modified — skipped events are excluded since
// no gesture went out) for the workspace, newest first. `summary` falls back
// to the admin's custom text on modified approvals; cost falls back to the
// approval's approved_budget_cents if a suggestion-based cost isn't present.
export type RecentGesture = {
  summary: string;
  kind: 'birthday' | 'anniversary';
  cost_cents: number;
  decided_at: string; // YYYY-MM-DD
};

export const listRecentApprovedGestures = async (
  db: Db,
  workspaceId: string,
  limit: number,
): Promise<RecentGesture[]> => {
  const rows = await db
    .select({
      summary: suggestions.gestureSummary,
      customText: approvals.customGestureText,
      kind: events.kind,
      approvedBudget: approvals.approvedBudgetCents,
      suggestionCost: suggestions.estimatedCostCents,
      decidedAt: approvals.decidedAt,
    })
    .from(approvals)
    .innerJoin(events, eq(events.id, approvals.eventId))
    .leftJoin(suggestions, eq(suggestions.id, approvals.chosenSuggestionId))
    .where(
      and(
        eq(events.workspaceId, workspaceId),
        inArray(approvals.decision, ['approved', 'modified']),
      ),
    )
    .orderBy(desc(approvals.decidedAt))
    .limit(limit);

  return rows.map((r) => ({
    summary: r.customText ?? r.summary ?? 'Custom gesture',
    kind: r.kind as 'birthday' | 'anniversary',
    cost_cents: r.approvedBudget ?? r.suggestionCost ?? 0,
    decided_at: r.decidedAt.toISOString().slice(0, 10),
  }));
};
