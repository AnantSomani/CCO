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
import { err, ok } from '@/lib/result';
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
          estimatedCostCents: 10_000,
        },
        estimatedCostCents: 10_000,
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
      findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
      addAddress: async () => ok({ success: true }),
      setDefaultAddress: async () => ok({ success: true }),
      searchRestaurants: async () => ok({ stores: [] }),
      getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
      getItemDetails: async () => ok({ extras: [] }),
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

  it('adds a newly approved DoorDash address before creating the cart', async () => {
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
          deliveryAddress: '1056 Foxhurst Way, San Jose, California 95120, United States',
          placeId: 'place-foxhurst',
          estimatedCostCents: 10_000,
        },
        estimatedCostCents: 10_000,
      },
    ]);
    if (!action) throw new Error('missing action');
    await approveAgentAction(db, action.id, WORKSPACE_ID, 'U_ADMIN');
    const addAddress = vi.fn<DdCliClient['addAddress']>().mockResolvedValue(ok({ success: true }));
    const addItems = vi
      .fn<DdCliClient['addItems']>()
      .mockResolvedValue(ok({ success: true, cart_uuid: 'cart-addr', item_errors: [] }));
    const setDefaultAddress = vi.fn<DdCliClient['setDefaultAddress']>();

    const result = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      doorDash: {
        listAddresses: async () => ok({ addresses: [] }),
        findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
        addAddress,
        setDefaultAddress,
        searchRestaurants: async () => ok({ stores: [] }),
        getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
        getItemDetails: async () => ok({ extras: [] }),
        listCarts: async () => ok({ carts: [] }),
        addItems,
        previewOrder: async () =>
          ok({
            success: true,
            quote: { net_total_before_tip: { display_string: '$20.00', unit_amount: 2000 } },
          }),
      },
      actionId: action.id,
    });

    expect(result).toEqual({ ok: true, value: { status: 'completed' } });
    expect(addAddress).toHaveBeenCalledWith(expect.objectContaining({ placeId: 'place-foxhurst' }));
    expect(setDefaultAddress).not.toHaveBeenCalled();
    expect(addAddress.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      addItems.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('sets an already-saved DoorDash address instead of adding a duplicate', async () => {
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
          deliveryAddress: '1056 Foxhurst Way, San Jose, CA 95120',
          placeId: 'place-foxhurst',
          estimatedCostCents: 10_000,
        },
        estimatedCostCents: 10_000,
      },
    ]);
    if (!action) throw new Error('missing action');
    await approveAgentAction(db, action.id, WORKSPACE_ID, 'U_ADMIN');
    const addAddress = vi.fn<DdCliClient['addAddress']>();
    const setDefaultAddress = vi
      .fn<DdCliClient['setDefaultAddress']>()
      .mockResolvedValue(ok({ success: true }));

    const result = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      doorDash: {
        listAddresses: async () =>
          ok({
            addresses: [
              {
                address_id: 'addr-foxhurst',
                printable_address: '1056 Foxhurst Way, San Jose, CA 95120',
                lat: 37.221,
                lng: -121.86,
                is_default: false,
              },
            ],
          }),
        findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
        addAddress,
        setDefaultAddress,
        searchRestaurants: async () => ok({ stores: [] }),
        getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
        getItemDetails: async () => ok({ extras: [] }),
        listCarts: async () => ok({ carts: [] }),
        addItems: async () => ok({ success: true, cart_uuid: 'cart-set', item_errors: [] }),
        previewOrder: async () =>
          ok({
            success: true,
            quote: { net_total_before_tip: { display_string: '$20.00', unit_amount: 2000 } },
          }),
      },
      actionId: action.id,
    });

    expect(result).toEqual({ ok: true, value: { status: 'completed' } });
    expect(setDefaultAddress).toHaveBeenCalledWith(
      expect.objectContaining({ addressId: 'addr-foxhurst' }),
    );
    expect(addAddress).not.toHaveBeenCalled();
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
      findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
      addAddress: async () => ok({ success: true }),
      setDefaultAddress: async () => ok({ success: true }),
      searchRestaurants: async () => ok({ stores: [] }),
      getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
      getItemDetails: async () => ok({ extras: [] }),
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

    expect(result).toEqual({ ok: true, value: { status: 'needs_review' } });
    expect(addItems).not.toHaveBeenCalled();
    expect((await getAgentAction(db, action.id))?.errorCode).toBe(
      'doordash_existing_cart_requires_review',
    );
  });

  it('resumes a preview from the persisted cart UUID without adding items again', async () => {
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
    const addItems = vi
      .fn<DdCliClient['addItems']>()
      .mockResolvedValueOnce(ok({ success: true, cart_uuid: 'cart-1', item_errors: [] }));
    const previewOrder = vi
      .fn<DdCliClient['previewOrder']>()
      .mockResolvedValueOnce(err('dd_cli_timeout'))
      .mockResolvedValueOnce(
        ok({
          success: true,
          quote: { net_total_before_tip: { display_string: '$80.00', unit_amount: 8000 } },
        }),
      );
    const doorDash: DdCliClient = {
      listAddresses: async () => ok({ addresses: [] }),
      findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
      addAddress: async () => ok({ success: true }),
      setDefaultAddress: async () => ok({ success: true }),
      searchRestaurants: async () => ok({ stores: [] }),
      getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
      getItemDetails: async () => ok({ extras: [] }),
      listCarts: async () => ok({ carts: [] }),
      addItems,
      previewOrder,
    };

    const first = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      doorDash,
      actionId: action.id,
    });
    expect(first.ok).toBe(false);

    const second = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      doorDash: {
        ...doorDash,
        listCarts: async () => ok({ carts: [{ cart_uuid: 'cart-1', store_id: 'store-1' }] }),
      },
      actionId: action.id,
    });
    const { getDoorDashExecutionByAction } = await import('@/db/queries/doordash-executions');
    const execution = await getDoorDashExecutionByAction(db, action.id, WORKSPACE_ID);

    expect(second).toEqual({ ok: true, value: { status: 'completed' } });
    expect(addItems).toHaveBeenCalledTimes(1);
    expect(previewOrder).toHaveBeenCalledTimes(2);
    expect(execution?.cartUuid).toBe('cart-1');
    expect(execution?.status).toBe('completed');
  });

  it('does not treat an over-limit live quote as approved', async () => {
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
          estimatedCostCents: 5000,
        },
        estimatedCostCents: 5000,
      },
    ]);
    if (!action) throw new Error('missing action');
    await approveAgentAction(db, action.id, WORKSPACE_ID, 'U_ADMIN');
    const result = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      doorDash: {
        listAddresses: async () => ok({ addresses: [] }),
        findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
        addAddress: async () => ok({ success: true }),
        setDefaultAddress: async () => ok({ success: true }),
        searchRestaurants: async () => ok({ stores: [] }),
        getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
        getItemDetails: async () => ok({ extras: [] }),
        listCarts: async () => ok({ carts: [] }),
        addItems: async () => ok({ success: true, cart_uuid: 'cart-over', item_errors: [] }),
        previewOrder: async () =>
          ok({
            success: true,
            quote: { net_total_before_tip: { display_string: '$80.00', unit_amount: 8000 } },
          }),
      },
      actionId: action.id,
    });
    const stored = await getAgentAction(db, action.id);
    expect(result).toEqual({ ok: true, value: { status: 'needs_review' } });
    expect(stored?.status).toBe('failed');
    expect(stored?.errorCode).toBe('doordash_quote_exceeds_approved_maximum');
  });

  it('does not retry a partial item-add batch', async () => {
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
    const addItems = vi.fn<DdCliClient['addItems']>().mockResolvedValue(
      ok({
        success: true,
        cart_uuid: 'cart-partial',
        item_errors: [{ item_id: 'item-1', message: 'unavailable' }],
      }),
    );
    const result = await runAgentAction({
      db,
      getSlackClient: recordingSlackClientFactory({}),
      doorDash: {
        listAddresses: async () => ok({ addresses: [] }),
        findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
        addAddress: async () => ok({ success: true }),
        setDefaultAddress: async () => ok({ success: true }),
        searchRestaurants: async () => ok({ stores: [] }),
        getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
        getItemDetails: async () => ok({ extras: [] }),
        listCarts: async () => ok({ carts: [] }),
        addItems,
        previewOrder: async () => ok({ success: true, quote: {} }),
      },
      actionId: action.id,
    });
    expect(result).toEqual({ ok: true, value: { status: 'needs_review' } });
    expect(addItems).toHaveBeenCalledTimes(1);
    expect((await getAgentAction(db, action.id))?.errorCode).toBe(
      'doordash_cart_items_need_review',
    );
  });

  it('surfaces required option errors instead of a missing cart UUID', async () => {
    const { db, run } = await seed();
    const [action] = await insertAgentActions(db, run, [
      {
        kind: 'doordash_order_preview',
        summary: 'Preview team pizza',
        payload: {
          storeId: 'store-1',
          restaurant: 'Round Table Pizza',
          menuId: 'menu-1',
          items: [{ itemId: 'item-1', itemName: 'Gourmet Veggie', quantity: 2 }],
          deliveryAddress: '1056 Foxhurst Way, San Jose, CA 95120',
          estimatedCostCents: 3200,
        },
        estimatedCostCents: 3200,
      },
    ]);
    if (!action) throw new Error('missing action');
    const { executeDoorDashPreview } = await import('@/jobs/doordash-preview');
    const result = await executeDoorDashPreview({
      db,
      workspaceId: WORKSPACE_ID,
      actionId: action.id,
      storeId: 'store-1',
      restaurant: 'Round Table Pizza',
      menuId: 'menu-1',
      items: [{ itemId: 'item-1', itemName: 'Gourmet Veggie', quantity: 2 }],
      deliveryAddress: '1056 Foxhurst Way, San Jose, CA 95120',
      approvedMaxCents: 3200,
      intent: 'intent',
      doorDash: {
        listAddresses: async () => ok({ addresses: [] }),
        findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
        addAddress: async () => ok({ success: true }),
        setDefaultAddress: async () => ok({ success: true }),
        searchRestaurants: async () => ok({ stores: [] }),
        getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
        getItemDetails: async () => ok({ extras: [] }),
        listCarts: async () => ok({ carts: [] }),
        addItems: async () =>
          ok({
            success: false,
            item_errors: [
              {
                item_name: 'Gourmet Veggie',
                required_options: [{ name: 'Size' }, { name: 'Crust' }],
              },
            ],
          }),
        previewOrder: async () => ok({ success: true, quote: {} }),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('Gourmet Veggie needs Size and Crust');
    expect(result.detail).not.toContain('cart UUID');
  });

  it('reuses a Confetti-owned cart and adds items with the saved UUID', async () => {
    const { db, run } = await seed();
    const [prior, action] = await insertAgentActions(db, run, [
      {
        kind: 'doordash_order_preview',
        summary: 'Preview team pizza',
        payload: {
          storeId: 'store-1',
          restaurant: "Mountain Mike's Pizza",
          menuId: 'menu-1',
          items: [{ itemId: 'item-1', itemName: 'Vegetarian Spicy Himalayan Pizza', quantity: 1 }],
          deliveryAddress: '1056 Foxhurst Way, San Jose, CA 95120',
          estimatedCostCents: 4500,
        },
        estimatedCostCents: 4500,
      },
      {
        kind: 'doordash_order_preview',
        summary: 'Preview team pizza with size',
        payload: {
          storeId: 'store-1',
          restaurant: "Mountain Mike's Pizza",
          menuId: 'menu-1',
          items: [
            {
              itemId: 'item-1',
              itemName: 'Vegetarian Spicy Himalayan Pizza',
              quantity: 1,
              nestedOptions: [{ id: 'opt-size-small', name: 'SMALL', quantity: 1 }],
            },
          ],
          deliveryAddress: '1056 Foxhurst Way, San Jose, CA 95120',
          estimatedCostCents: 4500,
        },
        estimatedCostCents: 4500,
      },
    ]);
    if (!prior || !action) throw new Error('missing actions');
    const { getOrCreateDoorDashExecution, updateDoorDashExecution } = await import(
      '@/db/queries/doordash-executions'
    );
    const priorExecution = await getOrCreateDoorDashExecution(db, {
      workspaceId: WORKSPACE_ID,
      actionId: prior.id,
      storeId: 'store-1',
      approvedMaxCents: 4500,
    });
    await updateDoorDashExecution(db, {
      executionId: priorExecution.id,
      workspaceId: WORKSPACE_ID,
      status: 'needs_review',
      checkpoint: 'cart_created',
      cartUuid: 'cart-owned',
      errorCode: 'doordash_cart_items_need_review',
    });
    const addItems = vi
      .fn<DdCliClient['addItems']>()
      .mockResolvedValue(ok({ success: true, cart_uuid: 'cart-owned', item_errors: [] }));
    const { executeDoorDashPreview } = await import('@/jobs/doordash-preview');
    const result = await executeDoorDashPreview({
      db,
      workspaceId: WORKSPACE_ID,
      actionId: action.id,
      storeId: 'store-1',
      restaurant: "Mountain Mike's Pizza",
      menuId: 'menu-1',
      items: [
        {
          itemId: 'item-1',
          itemName: 'Vegetarian Spicy Himalayan Pizza',
          quantity: 1,
          nestedOptions: [{ id: 'opt-size-small', name: 'SMALL', quantity: 1 }],
        },
      ],
      deliveryAddress: '1056 Foxhurst Way, San Jose, CA 95120',
      approvedMaxCents: 4500,
      intent: 'intent',
      doorDash: {
        listAddresses: async () => ok({ addresses: [] }),
        findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
        addAddress: async () => ok({ success: true }),
        setDefaultAddress: async () => ok({ success: true }),
        searchRestaurants: async () => ok({ stores: [] }),
        getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
        getItemDetails: async () => ok({ extras: [] }),
        listCarts: async () => ok({ carts: [{ cart_uuid: 'cart-owned' }] }),
        addItems,
        previewOrder: async () =>
          ok({
            success: true,
            quote: { net_total_before_tip: { display_string: '$24.98', unit_amount: 2498 } },
          }),
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ cartUuid: 'cart-owned', previewOnly: true }),
      }),
    );
    expect(addItems).toHaveBeenCalledWith(expect.objectContaining({ cartUuid: 'cart-owned' }));
  });

  it('adopts a cart when add-items succeeds without a UUID', async () => {
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
    const addItems = vi
      .fn<DdCliClient['addItems']>()
      .mockResolvedValue(ok({ success: true, item_errors: [] }));
    const listCarts = vi
      .fn<DdCliClient['listCarts']>()
      .mockResolvedValueOnce(ok({ carts: [] }))
      .mockResolvedValueOnce(ok({ carts: [{ cart_uuid: 'cart-adopted' }] }));
    const { executeDoorDashPreview } = await import('@/jobs/doordash-preview');
    const result = await executeDoorDashPreview({
      db,
      workspaceId: WORKSPACE_ID,
      actionId: action.id,
      storeId: 'store-1',
      restaurant: 'Local Pizza',
      menuId: 'menu-1',
      items: [{ itemId: 'item-1', itemName: 'Large Pizza', quantity: 2 }],
      deliveryAddress: '123 Market St',
      approvedMaxCents: 9000,
      intent: 'intent',
      doorDash: {
        listAddresses: async () => ok({ addresses: [] }),
        findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
        addAddress: async () => ok({ success: true }),
        setDefaultAddress: async () => ok({ success: true }),
        searchRestaurants: async () => ok({ stores: [] }),
        getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
        getItemDetails: async () => ok({ extras: [] }),
        listCarts,
        addItems,
        previewOrder: async () =>
          ok({
            success: true,
            quote: { net_total_before_tip: { display_string: '$20.00', unit_amount: 2000 } },
          }),
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ cartUuid: 'cart-adopted', previewOnly: true }),
      }),
    );
    expect(addItems).toHaveBeenCalledTimes(1);
  });

  it('adopts a later cart on recover without adding items again', async () => {
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
    const addItems = vi
      .fn<DdCliClient['addItems']>()
      .mockResolvedValue(ok({ success: true, item_errors: [] }));
    const doorDashBase = {
      listAddresses: async () => ok({ addresses: [] }),
      findAddresses: async () => ok({ success: true, candidates: [], count: 0 }),
      addAddress: async () => ok({ success: true }),
      setDefaultAddress: async () => ok({ success: true }),
      searchRestaurants: async () => ok({ stores: [] }),
      getMenu: async () => ok({ menu_id: 'menu-1', items: [] }),
      getItemDetails: async () => ok({ extras: [] }),
      addItems,
      previewOrder: async () =>
        ok({
          success: true,
          quote: { net_total_before_tip: { display_string: '$20.00', unit_amount: 2000 } },
        }),
    } satisfies Partial<DdCliClient>;
    const { executeDoorDashPreview } = await import('@/jobs/doordash-preview');
    const first = await executeDoorDashPreview({
      db,
      workspaceId: WORKSPACE_ID,
      actionId: action.id,
      storeId: 'store-1',
      restaurant: 'Local Pizza',
      menuId: 'menu-1',
      items: [{ itemId: 'item-1', itemName: 'Large Pizza', quantity: 2 }],
      deliveryAddress: '123 Market St',
      approvedMaxCents: 9000,
      intent: 'intent',
      doorDash: {
        ...doorDashBase,
        listCarts: async () => ok({ carts: [] }),
      } as DdCliClient,
    });
    expect(first.ok).toBe(false);

    const { reopenDoorDashExecution } = await import('@/db/queries/doordash-executions');
    await reopenDoorDashExecution(db, action.id, WORKSPACE_ID);
    const second = await executeDoorDashPreview({
      db,
      workspaceId: WORKSPACE_ID,
      actionId: action.id,
      storeId: 'store-1',
      restaurant: 'Local Pizza',
      menuId: 'menu-1',
      items: [{ itemId: 'item-1', itemName: 'Large Pizza', quantity: 2 }],
      deliveryAddress: '123 Market St',
      approvedMaxCents: 9000,
      intent: 'intent',
      doorDash: {
        ...doorDashBase,
        listCarts: async () => ok({ carts: [{ cart_uuid: 'cart-recovered' }] }),
      } as DdCliClient,
    });

    expect(second).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ cartUuid: 'cart-recovered' }),
      }),
    );
    expect(addItems).toHaveBeenCalledTimes(1);
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
