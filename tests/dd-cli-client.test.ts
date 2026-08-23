import { describe, expect, it, vi } from 'vitest';
import {
  buildDoorDashIntent,
  createDdCliClient,
  type DdCliCommandRunner,
  describeDdCliError,
} from '@/integrations/doordash/dd-cli-client';
import { err, ok } from '@/lib/result';
import addressListFixture from './fixtures/doordash/dd-cli-v0.2.3/address-list.json';
import cartAddItemsFixture from './fixtures/doordash/dd-cli-v0.2.3/cart-add-items.json';
import cartListFixture from './fixtures/doordash/dd-cli-v0.2.3/cart-list.json';
import menuFixture from './fixtures/doordash/dd-cli-v0.2.3/menu.json';
import orderPreviewFixture from './fixtures/doordash/dd-cli-v0.2.3/order-preview.json';
import restaurantSearchFixture from './fixtures/doordash/dd-cli-v0.2.3/restaurant-search.json';

describe('dd-cli client', () => {
  it('uses argument arrays and builds a read-only work-benefits preview', async () => {
    const run = vi
      .fn<DdCliCommandRunner>()
      .mockResolvedValue(ok(JSON.stringify(orderPreviewFixture)));
    const client = createDdCliClient({ run });

    const result = await client.previewOrder({
      cartUuid: 'cart-123',
      scheduledTime: '2026-08-14T19:00:00Z',
      includeWorkBenefits: true,
      intent: buildDoorDashIntent('Help the team preview lunch', 'Plan team lunch'),
    });

    expect(result.ok).toBe(true);
    const args = run.mock.calls[0]?.[0] ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        '--json-output',
        'order',
        'preview',
        '--cart-uuid',
        'cart-123',
        '--include-work-benefits',
      ]),
    );
    expect(args).not.toContain('submit');
    expect(args).not.toContain('checkout-url');
  });

  it('serializes approved item data without shell interpolation', async () => {
    const run = vi
      .fn<DdCliCommandRunner>()
      .mockResolvedValue(ok(JSON.stringify(cartAddItemsFixture)));
    const client = createDdCliClient({ run });
    await client.addItems({
      storeId: 'store; rm -rf /',
      menuId: 'menu-1',
      items: [{ itemId: 'item-1', itemName: 'Pizza "Special"', quantity: 2 }],
      intent: buildDoorDashIntent('Help the team preview lunch', 'Pizza please'),
    });

    const args = run.mock.calls[0]?.[0] ?? [];
    expect(args).toContain('store; rm -rf /');
    expect(args).toContain(
      JSON.stringify([{ item_id: 'item-1', item_name: 'Pizza "Special"', quantity: 2 }]),
    );
  });

  it.each([
    ['not json', 'dd_cli_invalid_json'],
    [JSON.stringify({ wrong: true }), 'dd_cli_unexpected_envelope'],
    [JSON.stringify({ content: [], isError: false }), 'dd_cli_missing_structured_content'],
    [
      JSON.stringify({ content: [], isError: false, structuredContent: { wrong: true } }),
      'dd_cli_unexpected_response',
    ],
  ])('rejects malformed output', async (output, expectedError) => {
    const client = createDdCliClient({ run: async () => ok(output) });
    const result = await client.listCarts({ storeId: 'store-1', intent: 'intent' });
    expect(result).toEqual(err(expectedError));
  });

  it.each([
    [
      { content: [{ type: 'text', text: 'Authentication token expired' }], isError: true },
      'dd_cli_auth_required',
    ],
    [
      { content: [{ type: 'text', text: 'Command could not be completed' }], isError: true },
      'dd_cli_command_error',
    ],
  ])('normalizes dd-cli error envelopes', async (envelope, expectedError) => {
    const client = createDdCliClient({
      run: async () => ok(JSON.stringify(envelope)),
    });
    expect(await client.listAddresses('intent')).toEqual(err(expectedError));
  });

  it('parses sanitized v0.2.3 fixtures for every used command', async () => {
    const run = vi
      .fn<DdCliCommandRunner>()
      .mockResolvedValueOnce(ok(JSON.stringify(addressListFixture)))
      .mockResolvedValueOnce(ok(JSON.stringify(restaurantSearchFixture)))
      .mockResolvedValueOnce(ok(JSON.stringify(menuFixture)))
      .mockResolvedValueOnce(ok(JSON.stringify(cartListFixture)))
      .mockResolvedValueOnce(ok(JSON.stringify(cartAddItemsFixture)))
      .mockResolvedValueOnce(ok(JSON.stringify(orderPreviewFixture)));
    const client = createDdCliClient({ run });

    const addresses = await client.listAddresses('intent');
    const restaurants = await client.searchRestaurants({
      query: 'pizza',
      lat: 37.789,
      lng: -122.394,
      intent: 'intent',
    });
    const menu = await client.getMenu({ storeId: 'store-test-1', intent: 'intent' });
    const carts = await client.listCarts({ storeId: 'store-test-1', intent: 'intent' });
    const mutation = await client.addItems({
      storeId: 'store-test-1',
      menuId: 'menu-test-1',
      items: [{ itemId: 'item-test-1', itemName: 'Test Margherita Pizza', quantity: 2 }],
      intent: 'intent',
    });
    const preview = await client.previewOrder({
      cartUuid: '00000000-0000-4000-8000-000000000101',
      includeWorkBenefits: false,
      intent: 'intent',
    });

    expect(addresses.ok && addresses.value.addresses[0]?.is_default).toBe(true);
    expect(addresses.ok && addresses.value.addresses[0]?.printable_address).toBe(
      '100 Test Street, San Francisco, CA 94105',
    );
    expect(restaurants.ok && restaurants.value.stores[0]?.name).toBe('Test Kitchen');
    expect(menu.ok && menu.value.items[0]?.name).toBe('Test Margherita Pizza');
    expect(carts.ok && carts.value.carts[0]?.store_name).toBe('Test Kitchen');
    expect(mutation.ok && mutation.value.cart_uuid).toBe('00000000-0000-4000-8000-000000000101');
    expect(preview.ok && preview.value.quote?.net_total_before_tip?.unit_amount).toBe(4210);
  });

  it('maps internal failures to deterministic, user-safe support messages', () => {
    expect(describeDdCliError('dd_cli_unexpected_response')).toContain('DD-CONTRACT');
    expect(describeDdCliError('dd_cli_auth_required')).toContain('DD-AUTH');
    expect(describeDdCliError('dd_cli_timeout')).toContain('DD-TIMEOUT');
    expect(describeDdCliError('unknown')).toContain('DD-EXECUTOR');
  });

  it('normalizes runner failures', async () => {
    const client = createDdCliClient({ run: async () => err('dd_cli_timeout') });
    const result = await client.listAddresses('intent');
    expect(result).toEqual(err('dd_cli_timeout'));
  });
});
