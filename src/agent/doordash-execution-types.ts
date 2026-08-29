import { z } from 'zod';

export const doorDashExecutionStatusSchema = z.enum([
  'in_progress',
  'needs_review',
  'completed',
  'recovered',
]);
export type DoorDashExecutionStatus = z.infer<typeof doorDashExecutionStatusSchema>;

export const doorDashCheckpointSchema = z.enum([
  'started',
  'listed_carts',
  'creating_cart',
  'cart_created',
  'items_added',
  'previewed',
  'completed',
]);
export type DoorDashCheckpoint = z.infer<typeof doorDashCheckpointSchema>;

export const doorDashItemResultsSchema = z.object({
  added: z
    .array(
      z.object({
        itemId: z.string(),
        itemName: z.string(),
        quantity: z.number().int(),
      }),
    )
    .default([]),
  failed: z.array(z.unknown()).default([]),
});
export type DoorDashItemResults = z.infer<typeof doorDashItemResultsSchema>;

export const quoteTotalCents = (quote: unknown): number | null => {
  if (!quote || typeof quote !== 'object') return null;
  const total = (quote as { net_total_before_tip?: { unit_amount?: unknown } })
    .net_total_before_tip;
  return typeof total?.unit_amount === 'number' ? total.unit_amount : null;
};
