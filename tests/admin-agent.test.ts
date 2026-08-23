import { describe, expect, it, vi } from 'vitest';
import { runAdminAgent } from '@/agent/admin-agent';
import type { Workspace } from '@/db/queries/workspaces';
import type { DdCliClient } from '@/integrations/doordash/dd-cli-client';
import { err, ok } from '@/lib/result';
import { messageWithToolUses, scriptedAnthropic } from './anthropic-stub';
import { createTestDb } from './db';

const workspace: Workspace = {
  id: '00000000-0000-4000-8000-000000000021',
  slackTeamId: 'T_AGENT',
  slackTeamName: 'Acme',
  installedBySlackUser: 'U_ADMIN',
  celebrationChannelId: null,
  defaultBudgetCents: 10_000,
  timezone: 'America/New_York',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const doorDashStub: DdCliClient = {
  listAddresses: async () =>
    ok({
      addresses: [
        {
          lat: 37.79,
          lng: -122.4,
          is_default: true,
          printable_address: '123 Market St, San Francisco, CA',
        },
      ],
    }),
  searchRestaurants: async () => ok({ stores: [{ store_id: 'store-1', name: 'Local Pizza' }] }),
  getMenu: async () =>
    ok({
      menu_id: 'menu-1',
      items: [{ item_id: 'item-1', name: 'Large Pepperoni Pizza' }],
    }),
  listCarts: async () => ok({ carts: [] }),
  addItems: async () => ok({ success: true, cart_uuid: 'cart-1' }),
  previewOrder: async () => ok({ success: true, quote: {} }),
};

describe('runAdminAgent', () => {
  it('labels the workspace budget as a per-event total', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          { id: 'tool-settings', name: 'get_workspace_settings', input: {} },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'The total per-event budget is $100.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      workspace,
      rawText: 'what is our current budget?',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(anthropic.calls[1]?.messages)).toContain(
      '\\"budgetScope\\":\\"per_event_total\\"',
    );
    expect(JSON.stringify(anthropic.calls[1]?.messages)).toContain(
      '\\"defaultPerEventBudgetCents\\":10000',
    );
  });

  it('returns a grounded budget proposal without applying it', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-budget',
            name: 'propose_set_default_budget',
            input: { amount_usd: 75, summary: 'Set the default celebration budget to $75' },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'I prepared the $75 budget change for approval.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      workspace,
      rawText: 'set our default budget to $75',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedActions).toEqual([
      {
        kind: 'set_default_budget',
        summary: 'Set the default celebration budget to $75',
        payload: { amountCents: 7500 },
        estimatedCostCents: null,
      },
    ]);
  });

  it('rejects a budget amount not present in the user request', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-budget',
            name: 'propose_set_default_budget',
            input: { amount_usd: 75, summary: 'Set budget to $75' },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'Please confirm the exact amount.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      workspace,
      rawText: 'set our budget to $50',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedActions).toEqual([]);
    expect(JSON.stringify(anthropic.calls[1]?.messages)).toContain(
      'not explicitly present in the user request',
    );
  });

  it('creates a sandbox food-order proposal under budget', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-order',
            name: 'propose_sandbox_food_order',
            input: {
              restaurant: 'Local Pizza',
              itemsDescription: 'Five large pizzas',
              headcount: 20,
              deliveryAt: '2026-08-12T11:00:00-07:00',
              deliveryAddress: '123 Market St, San Francisco, CA',
              estimatedCostCents: 9000,
              summary: 'Sandbox pizza order for 20 people',
            },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'I prepared a sandbox order for approval.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      workspace,
      rawText:
        'Plan a sandbox pizza order from Local Pizza for 20 people at 123 Market St, San Francisco, CA on August 12 at 11am PT for about $90.',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedActions[0]?.kind).toBe('sandbox_food_order');
    expect(result.value.proposedActions[0]?.estimatedCostCents).toBe(9000);
  });

  it('grounds a DoorDash preview in live discovery results', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-search',
            name: 'doordash_search_restaurants',
            input: { query: 'Local Pizza' },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-menu',
            name: 'doordash_get_menu',
            input: { store_id: 'store-1' },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-preview',
            name: 'propose_doordash_order_preview',
            input: {
              storeId: 'store-1',
              restaurant: 'Local Pizza',
              menuId: 'menu-1',
              items: [{ itemId: 'item-1', itemName: 'Large Pepperoni Pizza', quantity: 2 }],
              deliveryAt: '2026-08-14T19:00:00Z',
              deliveryAddress: '123 Market St, San Francisco, CA',
              estimatedCostCents: 9000,
              summary: 'Preview two pepperoni pizzas on DoorDash',
            },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: { reply_text: 'I prepared a DoorDash preview for approval.' },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      doorDash: doorDashStub,
      workspace,
      rawText: 'Preview 2 Large Pepperoni Pizzas from Local Pizza at 7pm for no more than $90.',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedActions).toEqual([
      {
        kind: 'doordash_order_preview',
        summary: 'Preview two pepperoni pizzas on DoorDash',
        payload: {
          storeId: 'store-1',
          restaurant: 'Local Pizza',
          menuId: 'menu-1',
          items: [{ itemId: 'item-1', itemName: 'Large Pepperoni Pizza', quantity: 2 }],
          deliveryAt: '2026-08-14T19:00:00Z',
          deliveryAddress: '123 Market St, San Francisco, CA',
          estimatedCostCents: 9000,
        },
        estimatedCostCents: 9000,
      },
    ]);
  });

  it('gives the model a deterministic support code for DoorDash contract failures', async () => {
    const db = await createTestDb();
    const anthropic = scriptedAnthropic([
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-search',
            name: 'doordash_search_restaurants',
            input: { query: 'Local Pizza' },
          },
        ]),
      },
      {
        kind: 'message',
        message: messageWithToolUses([
          {
            id: 'tool-final',
            name: 'finalize_response',
            input: {
              reply_text: 'DoorDash returned an incompatible response. Support code: DD-CONTRACT.',
            },
          },
        ]),
      },
    ]);

    const result = await runAdminAgent({
      anthropic: anthropic.client,
      db,
      doorDash: {
        ...doorDashStub,
        listAddresses: async () => err('dd_cli_unexpected_response'),
      },
      workspace,
      rawText: 'Find Local Pizza on DoorDash',
      userId: 'U_ADMIN',
      log,
    });

    expect(result.ok).toBe(true);
    const toolResults = JSON.stringify(anthropic.calls[1]?.messages);
    expect(toolResults).toContain('DD-CONTRACT');
    expect(toolResults).toContain('Do not infer another cause');
    expect(toolResults).not.toContain('address formatting');
  });
});
