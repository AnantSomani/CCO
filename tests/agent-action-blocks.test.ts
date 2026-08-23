import { describe, expect, it } from 'vitest';
import {
  buildAgentActionConfirmation,
  buildAgentActionResolved,
} from '@/slack/blocks/agent-action';

describe('DoorDash agent action blocks', () => {
  it('states that approval can mutate a cart but cannot charge an order', () => {
    const message = buildAgentActionConfirmation({
      id: 'action-1',
      kind: 'doordash_order_preview',
      summary: 'Preview team pizza',
      payload: {
        storeId: 'store-1',
        restaurant: 'Local Pizza',
        menuId: 'menu-1',
        items: [{ itemId: 'item-1', itemName: 'Large Pizza', quantity: 2 }],
        deliveryAt: '2026-08-14T19:00:00Z',
        deliveryAddress: '123 Market St',
        estimatedCostCents: 9000,
      },
      estimatedCostCents: 9000,
    });

    const serialized = JSON.stringify(message.blocks);
    expect(serialized).toContain('creates or changes a DoorDash cart');
    expect(serialized).toContain('cannot submit an order or charge a payment method');
    expect(serialized).toContain('2× Large Pizza');
  });

  it('surfaces the authoritative preview total and no-charge statement', () => {
    const message = buildAgentActionResolved({
      actionId: 'action-1',
      kind: 'doordash_order_preview',
      summary: 'Preview team pizza',
      status: 'completed',
      detail:
        'Preview ready for Local Pizza. Total before tip: $94.20. No order was submitted and no payment method was charged.',
    });

    expect(JSON.stringify(message.blocks)).toContain('$94.20');
    expect(JSON.stringify(message.blocks)).toContain('No order was submitted');
  });
});
