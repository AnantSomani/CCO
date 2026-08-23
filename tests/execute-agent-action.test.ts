import { describe, expect, it, vi } from 'vitest';
import {
  approveAgentAction,
  createAgentRun,
  getAgentAction,
  insertAgentActions,
} from '@/db/queries/agent-operations';
import {
  getArtifactById,
  getOrCreateOpenSession,
  upsertOpenArtifact,
} from '@/db/queries/agent-sessions';
import { getWorkspaceById } from '@/db/queries/workspaces';
import { workspaces } from '@/db/schema';
import type { DdCliClient } from '@/integrations/doordash/dd-cli-client';
import { runAgentAction } from '@/jobs/execute-agent-action';
import { ok } from '@/lib/result';
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

  it('creates a DoorDash cart preview without submitting an order', async () => {
    const { db, run } = await seed();
    const [action] = await insertAgentActions(db, run, [
      {
        kind: 'doordash_order_preview',
        summary: 'Preview team pizza',
        payload: {
          storeId: 'store-1',
          restaurant: 'Local Pizza',
          menuId: 'menu-1',
          items: [{ itemId: 'item-1', itemName: 'Large Pizza', quantity: 2 }],
          deliveryAt: '2026-08-14T19:00:00.000Z',
          deliveryAddress: '123 Market St',
          estimatedCostCents: 9000,
        },
        estimatedCostCents: 9000,
      },
    ]);
    if (!action) throw new Error('missing action');
    await approveAgentAction(db, action.id, WORKSPACE_ID, 'U_ADMIN');
    const previewOrder = vi.fn<DdCliClient['previewOrder']>().mockResolvedValue(
      ok({
        success: true,
        quote: {
          net_total_before_tip: { display_string: '$94.20', unit_amount: 9420 },
          line_items: [],
        },
      }),
    );
    const doorDash: DdCliClient = {
      listAddresses: async () => ok({ addresses: [] }),
      searchRestaurants: async () => ok({ stores: [] }),
      getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
      listCarts: async () => ok({ carts: [] }),
      addItems: async () => ok({ success: true, cart_uuid: 'cart-1', item_errors: [] }),
      previewOrder,
    };

    const result = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      doorDash,
      actionId: action.id,
    });
    const stored = await getAgentAction(db, action.id);

    expect(result).toEqual({ ok: true, value: { status: 'completed' } });
    expect(previewOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        cartUuid: 'cart-1',
        includeWorkBenefits: true,
      }),
    );
    expect(stored?.executionResult).toMatchObject({
      previewOnly: true,
      cartUuid: 'cart-1',
      quote: { net_total_before_tip: { display_string: '$94.20' } },
    });
  });

  it('does not append to an existing DoorDash cart', async () => {
    const { db, run } = await seed();
    const [action] = await insertAgentActions(db, run, [
      {
        kind: 'doordash_order_preview',
        summary: 'Preview team pizza',
        payload: {
          storeId: 'store-1',
          restaurant: 'Local Pizza',
          menuId: 'menu-1',
          items: [{ itemId: 'item-1', itemName: 'Large Pizza', quantity: 2 }],
          deliveryAddress: '123 Market St',
          estimatedCostCents: 9000,
        },
        estimatedCostCents: 9000,
      },
    ]);
    if (!action) throw new Error('missing action');
    await approveAgentAction(db, action.id, WORKSPACE_ID, 'U_ADMIN');
    const addItems = vi.fn<DdCliClient['addItems']>();
    const doorDash: DdCliClient = {
      listAddresses: async () => ok({ addresses: [] }),
      searchRestaurants: async () => ok({ stores: [] }),
      getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
      listCarts: async () => ok({ carts: [{ cart_uuid: 'existing-cart', store_id: 'store-1' }] }),
      addItems,
      previewOrder: async () => ok({ success: true, quote: {} }),
    };

    const result = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      doorDash,
      actionId: action.id,
    });

    expect(result).toEqual({ ok: false, error: 'doordash_existing_cart_requires_review' });
    expect(addItems).not.toHaveBeenCalled();
  });

  it('schedules an approved reminder exactly once', async () => {
    const { db, run } = await seed();
    const session = await getOrCreateOpenSession(db, {
      workspaceId: WORKSPACE_ID,
      slackUserId: 'U_ADMIN',
    });
    const artifact = await upsertOpenArtifact(db, {
      sessionId: session.id,
      workspaceId: WORKSPACE_ID,
      kind: 'reminder',
      slots: { title: 'Party', fireAt: '2026-08-22T19:00:00.000Z' },
    });
    const [action] = await insertAgentActions(db, run, [
      {
        kind: 'schedule_reminder',
        summary: 'Remind me about the party',
        payload: {
          title: 'Party',
          fireAt: '2026-08-22T19:00:00.000Z',
          artifactId: artifact.id,
        },
        estimatedCostCents: null,
      },
    ]);
    if (!action) throw new Error('missing action');
    await approveAgentAction(db, action.id, WORKSPACE_ID, 'U_ADMIN');
    const emitReminder = vi.fn(async () => undefined);

    const result = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      emitReminder,
      actionId: action.id,
    });

    expect(result).toEqual({ ok: true, value: { status: 'completed' } });
    expect(emitReminder).toHaveBeenCalledTimes(1);
    expect((await getArtifactById(db, artifact.id, WORKSPACE_ID))?.status).toBe('scheduled');
  });
});
