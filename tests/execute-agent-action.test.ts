import { describe, expect, it } from 'vitest';
import {
  approveAgentAction,
  createAgentRun,
  getAgentAction,
  insertAgentActions,
} from '@/db/queries/agent-operations';
import { getWorkspaceById } from '@/db/queries/workspaces';
import { workspaces } from '@/db/schema';
import { runAgentAction } from '@/jobs/execute-agent-action';
import { createTestDb } from './db';
import { recordingSlackClientFactory } from './slack-stub';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000031';

const seed = async () => {
  const db = await createTestDb();
  await db.insert(workspaces).values({
    id: WORKSPACE_ID,
    slackTeamId: 'T_EXECUTE',
    slackTeamName: 'Execute Test',
    botAccessTokenEnc: 'stub',
    installedBySlackUser: 'U_ADMIN',
    defaultBudgetCents: 10_000,
  });
  const created = await createAgentRun(db, {
    workspaceId: WORKSPACE_ID,
    requestedBySlackUser: 'U_ADMIN',
    requestText: 'test',
    idempotencyKey: 'run-1',
  });
  return { db, run: created.run };
};

describe('runAgentAction', () => {
  it('executes an approved budget change idempotently', async () => {
    const { db, run } = await seed();
    const [action] = await insertAgentActions(db, run, [
      {
        kind: 'set_default_budget',
        summary: 'Set budget to $75',
        payload: { amountCents: 7500 },
        estimatedCostCents: null,
      },
    ]);
    if (!action) throw new Error('missing action');
    await approveAgentAction(db, action.id, WORKSPACE_ID, 'U_ADMIN');

    const first = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      actionId: action.id,
    });
    const second = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      actionId: action.id,
    });

    expect(first).toEqual({ ok: true, value: { status: 'completed' } });
    expect(second).toEqual({ ok: true, value: { status: 'already_finished' } });
    expect((await getWorkspaceById(db, WORKSPACE_ID))?.defaultBudgetCents).toBe(7500);
  });

  it('completes a sandbox order without external effects', async () => {
    const { db, run } = await seed();
    const [action] = await insertAgentActions(db, run, [
      {
        kind: 'sandbox_food_order',
        summary: 'Sandbox lunch',
        payload: {
          restaurant: 'Local Pizza',
          itemsDescription: 'Five pizzas',
          headcount: 20,
          deliveryAt: '2026-08-12T18:00:00.000Z',
          deliveryAddress: '123 Market St',
          estimatedCostCents: 9000,
        },
        estimatedCostCents: 9000,
      },
    ]);
    if (!action) throw new Error('missing action');
    await approveAgentAction(db, action.id, WORKSPACE_ID, 'U_ADMIN');

    const result = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      actionId: action.id,
    });
    const stored = await getAgentAction(db, action.id);

    expect(result).toEqual({ ok: true, value: { status: 'completed' } });
    expect(stored?.executionResult).toMatchObject({
      sandbox: true,
      status: 'confirmed',
      restaurant: 'Local Pizza',
    });
  });
});
