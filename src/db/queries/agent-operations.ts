import { and, count, eq, gte, lt, or } from 'drizzle-orm';
import type {
  AgentActionKind,
  AgentActionStatus,
  ProposedAgentAction,
} from '@/agent/command-types';
import type { Db } from '@/db/client';
import { agentActions, agentRuns } from '@/db/schema';

export type AgentRun = {
  id: string;
  workspaceId: string;
  requestedBySlackUser: string;
  requestText: string;
  status: string;
  idempotencyKey: string;
  responseText: string | null;
  responseChannelId: string | null;
  responseMessageTs: string | null;
  model: string | null;
  toolCalls: unknown;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type AgentAction = {
  id: string;
  runId: string;
  workspaceId: string;
  requestedBySlackUser: string;
  kind: AgentActionKind;
  summary: string;
  payload: unknown;
  estimatedCostCents: number | null;
  status: AgentActionStatus;
  idempotencyKey: string;
  confirmationChannelId: string | null;
  confirmationMessageTs: string | null;
  approvedBySlackUser: string | null;
  approvedAt: Date | null;
  executionResult: unknown;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

const toRun = (row: typeof agentRuns.$inferSelect): AgentRun => row;

const toAction = (row: typeof agentActions.$inferSelect): AgentAction => ({
  ...row,
  kind: row.kind as AgentActionKind,
  status: row.status as AgentActionStatus,
});

export const createAgentRun = async (
  db: Db,
  input: {
    workspaceId: string;
    requestedBySlackUser: string;
    requestText: string;
    idempotencyKey: string;
  },
): Promise<{ run: AgentRun; created: boolean }> => {
  const inserted = await db
    .insert(agentRuns)
    .values(input)
    .onConflictDoNothing({ target: agentRuns.idempotencyKey })
    .returning();
  const created = inserted[0];
  if (created) return { run: toRun(created), created: true };

  const existing = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.idempotencyKey, input.idempotencyKey))
    .limit(1);
  const run = existing[0];
  if (!run) throw new Error('agent run conflict did not return an existing row');
  return { run: toRun(run), created: false };
};

export const countRecentAgentRuns = async (
  db: Db,
  workspaceId: string,
  slackUserId: string,
  since: Date,
): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        eq(agentRuns.requestedBySlackUser, slackUserId),
        gte(agentRuns.createdAt, since),
      ),
    );
  return rows[0]?.value ?? 0;
};

export const markAgentRunRunning = async (db: Db, runId: string): Promise<void> => {
  await db
    .update(agentRuns)
    .set({ status: 'running', startedAt: new Date(), errorCode: null })
    .where(eq(agentRuns.id, runId));
};

export const completeAgentRun = async (
  db: Db,
  runId: string,
  responseText: string,
  model: string,
  toolCalls: unknown,
): Promise<void> => {
  await db
    .update(agentRuns)
    .set({
      status: 'completed',
      responseText,
      model,
      toolCalls,
      completedAt: new Date(),
      errorCode: null,
    })
    .where(eq(agentRuns.id, runId));
};

export const failAgentRun = async (db: Db, runId: string, errorCode: string): Promise<void> => {
  await db
    .update(agentRuns)
    .set({ status: 'failed', errorCode, completedAt: new Date() })
    .where(eq(agentRuns.id, runId));
};

export const setAgentRunResponseMessage = async (
  db: Db,
  runId: string,
  channelId: string,
  messageTs: string,
): Promise<void> => {
  await db
    .update(agentRuns)
    .set({ responseChannelId: channelId, responseMessageTs: messageTs })
    .where(eq(agentRuns.id, runId));
};

export const getAgentRun = async (db: Db, runId: string): Promise<AgentRun | null> => {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return rows[0] ? toRun(rows[0]) : null;
};

export const getAgentRunByIdempotencyKey = async (
  db: Db,
  idempotencyKey: string,
): Promise<AgentRun | null> => {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0] ? toRun(rows[0]) : null;
};

export const insertAgentActions = async (
  db: Db,
  run: AgentRun,
  proposed: ProposedAgentAction[],
): Promise<AgentAction[]> => {
  if (proposed.length === 0) return [];
  const rows = await db
    .insert(agentActions)
    .values(
      proposed.map((action, index) => ({
        runId: run.id,
        workspaceId: run.workspaceId,
        requestedBySlackUser: run.requestedBySlackUser,
        kind: action.kind,
        summary: action.summary,
        payload: action.payload,
        estimatedCostCents: action.estimatedCostCents,
        idempotencyKey: `${run.id}:${index}`,
      })),
    )
    .onConflictDoNothing({ target: agentActions.idempotencyKey })
    .returning();

  if (rows.length > 0) return rows.map(toAction);

  const existing = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.runId, run.id))
    .orderBy(agentActions.createdAt);
  return existing.map(toAction);
};

export const getAgentAction = async (db: Db, actionId: string): Promise<AgentAction | null> => {
  const rows = await db.select().from(agentActions).where(eq(agentActions.id, actionId)).limit(1);
  return rows[0] ? toAction(rows[0]) : null;
};

export const setAgentActionConfirmationMessage = async (
  db: Db,
  actionId: string,
  channelId: string,
  messageTs: string,
): Promise<void> => {
  await db
    .update(agentActions)
    .set({
      confirmationChannelId: channelId,
      confirmationMessageTs: messageTs,
      updatedAt: new Date(),
    })
    .where(eq(agentActions.id, actionId));
};

export const approveAgentAction = async (
  db: Db,
  actionId: string,
  workspaceId: string,
  approvedBySlackUser: string,
): Promise<AgentAction | null> => {
  const rows = await db
    .update(agentActions)
    .set({
      status: 'approved',
      approvedBySlackUser,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentActions.id, actionId),
        eq(agentActions.workspaceId, workspaceId),
        eq(agentActions.status, 'pending_confirmation'),
      ),
    )
    .returning();
  return rows[0] ? toAction(rows[0]) : null;
};

export const rejectAgentAction = async (
  db: Db,
  actionId: string,
  workspaceId: string,
  rejectedBySlackUser: string,
): Promise<AgentAction | null> => {
  const rows = await db
    .update(agentActions)
    .set({
      status: 'rejected',
      approvedBySlackUser: rejectedBySlackUser,
      approvedAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    .where(
      and(
        eq(agentActions.id, actionId),
        eq(agentActions.workspaceId, workspaceId),
        eq(agentActions.status, 'pending_confirmation'),
      ),
    )
    .returning();
  return rows[0] ? toAction(rows[0]) : null;
};

export const beginAgentActionExecution = async (
  db: Db,
  actionId: string,
): Promise<AgentAction | null> => {
  const rows = await db
    .update(agentActions)
    .set({ status: 'executing', updatedAt: new Date() })
    .where(and(eq(agentActions.id, actionId), eq(agentActions.status, 'approved')))
    .returning();
  if (rows[0]) return toAction(rows[0]);
  const existing = await getAgentAction(db, actionId);
  return existing?.status === 'executing' ? existing : null;
};

export const completeAgentAction = async (
  db: Db,
  actionId: string,
  executionResult: unknown,
): Promise<void> => {
  await db
    .update(agentActions)
    .set({
      status: 'completed',
      executionResult,
      errorCode: null,
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    .where(eq(agentActions.id, actionId));
};

export const failAgentAction = async (
  db: Db,
  actionId: string,
  errorCode: string,
): Promise<void> => {
  await db
    .update(agentActions)
    .set({
      status: 'failed',
      errorCode,
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    .where(eq(agentActions.id, actionId));
};

export const cancelCompletedSandboxAction = async (
  db: Db,
  actionId: string,
  workspaceId: string,
  cancelledBySlackUser: string,
): Promise<AgentAction | null> => {
  const rows = await db
    .update(agentActions)
    .set({
      status: 'cancelled',
      approvedBySlackUser: cancelledBySlackUser,
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    .where(
      and(
        eq(agentActions.id, actionId),
        eq(agentActions.workspaceId, workspaceId),
        eq(agentActions.status, 'completed'),
        or(
          eq(agentActions.kind, 'sandbox_food_order'),
          eq(agentActions.kind, 'sandbox_event_plan'),
        ),
      ),
    )
    .returning();
  return rows[0] ? toAction(rows[0]) : null;
};

export const deleteExpiredAgentRuns = async (db: Db, before: Date): Promise<number> => {
  const rows = await db
    .delete(agentRuns)
    .where(
      and(
        lt(agentRuns.createdAt, before),
        or(eq(agentRuns.status, 'completed'), eq(agentRuns.status, 'failed')),
      ),
    )
    .returning({ id: agentRuns.id });
  return rows.length;
};
