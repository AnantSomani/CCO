import { and, eq, inArray } from 'drizzle-orm';
import {
  type DoorDashCheckpoint,
  type DoorDashExecutionStatus,
  type DoorDashItemResults,
  doorDashItemResultsSchema,
} from '@/agent/doordash-execution-types';
import type { Db } from '@/db/client';
import { agentDoordashExecutions } from '@/db/schema';

export type DoorDashExecution = {
  id: string;
  workspaceId: string;
  actionId: string;
  status: DoorDashExecutionStatus;
  checkpoint: DoorDashCheckpoint;
  storeId: string;
  cartUuid: string | null;
  approvedMaxCents: number;
  liveTotalCents: number | null;
  listedCartUuids: string[];
  itemResults: DoorDashItemResults;
  quote: unknown;
  errorCode: string | null;
  cartIdempotencyKey: string;
  itemsIdempotencyKey: string;
  previewIdempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

const toExecution = (row: typeof agentDoordashExecutions.$inferSelect): DoorDashExecution => ({
  ...row,
  status: row.status as DoorDashExecutionStatus,
  checkpoint: row.checkpoint as DoorDashCheckpoint,
  listedCartUuids: row.listedCartUuids ?? [],
  itemResults: doorDashItemResultsSchema.parse(row.itemResults ?? {}),
});

export const getDoorDashExecutionByAction = async (
  db: Db,
  actionId: string,
  workspaceId: string,
): Promise<DoorDashExecution | null> => {
  const rows = await db
    .select()
    .from(agentDoordashExecutions)
    .where(
      and(
        eq(agentDoordashExecutions.actionId, actionId),
        eq(agentDoordashExecutions.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return rows[0] ? toExecution(rows[0]) : null;
};

export const getOrCreateDoorDashExecution = async (
  db: Db,
  input: {
    workspaceId: string;
    actionId: string;
    storeId: string;
    approvedMaxCents: number;
  },
): Promise<DoorDashExecution> => {
  const existing = await getDoorDashExecutionByAction(db, input.actionId, input.workspaceId);
  if (existing) return existing;
  const inserted = await db
    .insert(agentDoordashExecutions)
    .values({
      workspaceId: input.workspaceId,
      actionId: input.actionId,
      storeId: input.storeId,
      approvedMaxCents: input.approvedMaxCents,
      cartIdempotencyKey: `dd-cart:${input.actionId}`,
      itemsIdempotencyKey: `dd-items:${input.actionId}`,
      previewIdempotencyKey: `dd-preview:${input.actionId}`,
    })
    .onConflictDoNothing({ target: agentDoordashExecutions.actionId })
    .returning();
  if (inserted[0]) return toExecution(inserted[0]);
  const raced = await getDoorDashExecutionByAction(db, input.actionId, input.workspaceId);
  if (!raced) throw new Error('failed to create DoorDash execution');
  return raced;
};

export const updateDoorDashExecution = async (
  db: Db,
  input: {
    executionId: string;
    workspaceId: string;
    status?: DoorDashExecutionStatus;
    checkpoint?: DoorDashCheckpoint;
    cartUuid?: string | null;
    listedCartUuids?: string[];
    itemResults?: DoorDashItemResults;
    quote?: unknown;
    liveTotalCents?: number | null;
    errorCode?: string | null;
  },
): Promise<DoorDashExecution | null> => {
  const rows = await db
    .update(agentDoordashExecutions)
    .set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
      ...(input.cartUuid !== undefined ? { cartUuid: input.cartUuid } : {}),
      ...(input.listedCartUuids ? { listedCartUuids: input.listedCartUuids } : {}),
      ...(input.itemResults ? { itemResults: input.itemResults } : {}),
      ...(input.quote !== undefined ? { quote: input.quote } : {}),
      ...(input.liveTotalCents !== undefined ? { liveTotalCents: input.liveTotalCents } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentDoordashExecutions.id, input.executionId),
        eq(agentDoordashExecutions.workspaceId, input.workspaceId),
      ),
    )
    .returning();
  return rows[0] ? toExecution(rows[0]) : null;
};

export const listOwnedDoorDashCartUuids = async (
  db: Db,
  workspaceId: string,
  storeId: string,
): Promise<Set<string>> => {
  const rows = await db
    .select({ cartUuid: agentDoordashExecutions.cartUuid })
    .from(agentDoordashExecutions)
    .where(
      and(
        eq(agentDoordashExecutions.workspaceId, workspaceId),
        eq(agentDoordashExecutions.storeId, storeId),
        inArray(agentDoordashExecutions.status, ['in_progress', 'needs_review']),
      ),
    );
  return new Set(rows.flatMap((row) => (row.cartUuid ? [row.cartUuid] : [])));
};

export const listRecoverableDoorDashExecutions = async (
  db: Db,
  workspaceId: string,
): Promise<DoorDashExecution[]> => {
  const rows = await db
    .select()
    .from(agentDoordashExecutions)
    .where(
      and(
        eq(agentDoordashExecutions.workspaceId, workspaceId),
        inArray(agentDoordashExecutions.status, ['in_progress', 'needs_review']),
      ),
    );
  return rows.map(toExecution);
};

export const reopenDoorDashExecution = async (
  db: Db,
  actionId: string,
  workspaceId: string,
): Promise<DoorDashExecution | null> => {
  const rows = await db
    .update(agentDoordashExecutions)
    .set({
      status: 'in_progress',
      errorCode: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentDoordashExecutions.actionId, actionId),
        eq(agentDoordashExecutions.workspaceId, workspaceId),
        eq(agentDoordashExecutions.status, 'needs_review'),
      ),
    )
    .returning();
  return rows[0] ? toExecution(rows[0]) : null;
};

export const markDoorDashExecutionRecovered = async (
  db: Db,
  actionId: string,
  workspaceId: string,
): Promise<DoorDashExecution | null> => {
  const rows = await db
    .update(agentDoordashExecutions)
    .set({
      status: 'recovered',
      errorCode: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentDoordashExecutions.actionId, actionId),
        eq(agentDoordashExecutions.workspaceId, workspaceId),
        inArray(agentDoordashExecutions.status, ['in_progress', 'needs_review']),
      ),
    )
    .returning();
  return rows[0] ? toExecution(rows[0]) : null;
};
