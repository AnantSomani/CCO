import { z } from 'zod';

export const agentActionKindSchema = z.enum([
  'set_default_budget',
  'set_celebration_channel',
  'sandbox_food_order',
  'doordash_order_preview',
  'sandbox_event_plan',
  'schedule_reminder',
]);

export type AgentActionKind = z.infer<typeof agentActionKindSchema>;

export const agentActionStatusSchema = z.enum([
  'pending_confirmation',
  'approved',
  'executing',
  'completed',
  'rejected',
  'cancelled',
  'failed',
]);

export type AgentActionStatus = z.infer<typeof agentActionStatusSchema>;

export const setDefaultBudgetPayloadSchema = z.object({
  amountCents: z.number().int().positive().max(1_000_000),
});

export const setCelebrationChannelPayloadSchema = z.object({
  channelId: z.string().regex(/^C[A-Z0-9]+$/),
});

export const sandboxFoodOrderPayloadSchema = z.object({
  restaurant: z.string().min(1).max(120),
  itemsDescription: z.string().min(1).max(500),
  headcount: z.number().int().min(1).max(500),
  deliveryAt: z.string().datetime({ offset: true }),
  deliveryAddress: z.string().min(1).max(300),
  estimatedCostCents: z.number().int().positive().max(1_000_000),
});

export const doorDashOrderItemSchema = z.object({
  itemId: z.string().min(1).max(100),
  itemName: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(100),
  nestedOptions: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
});

export const doorDashOrderPreviewPayloadSchema = z.object({
  storeId: z.string().min(1).max(100),
  restaurant: z.string().min(1).max(120),
  menuId: z.string().min(1).max(100),
  items: z.array(doorDashOrderItemSchema).min(1).max(30),
  deliveryAt: z.string().datetime({ offset: true }).optional(),
  deliveryAddress: z.string().min(1).max(300),
  estimatedCostCents: z.number().int().positive().max(1_000_000),
});

export const sandboxEventPlanPayloadSchema = z.object({
  title: z.string().min(1).max(120),
  eventAt: z.string().datetime({ offset: true }),
  location: z.string().min(1).max(300),
  headcount: z.number().int().min(1).max(500),
  agenda: z.string().min(1).max(1000),
  estimatedCostCents: z.number().int().nonnegative().max(1_000_000),
});

export const scheduleReminderPayloadSchema = z.object({
  title: z.string().min(1).max(160),
  fireAt: z.string().datetime({ offset: true }),
  note: z.string().min(1).max(500).optional(),
  artifactId: z.string().uuid().optional(),
});

export const proposedAgentActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('set_default_budget'),
    summary: z.string().min(1).max(160),
    payload: setDefaultBudgetPayloadSchema,
    estimatedCostCents: z.null(),
  }),
  z.object({
    kind: z.literal('set_celebration_channel'),
    summary: z.string().min(1).max(160),
    payload: setCelebrationChannelPayloadSchema,
    estimatedCostCents: z.null(),
  }),
  z.object({
    kind: z.literal('sandbox_food_order'),
    summary: z.string().min(1).max(160),
    payload: sandboxFoodOrderPayloadSchema,
    estimatedCostCents: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('doordash_order_preview'),
    summary: z.string().min(1).max(160),
    payload: doorDashOrderPreviewPayloadSchema,
    estimatedCostCents: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('sandbox_event_plan'),
    summary: z.string().min(1).max(160),
    payload: sandboxEventPlanPayloadSchema,
    estimatedCostCents: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('schedule_reminder'),
    summary: z.string().min(1).max(160),
    payload: scheduleReminderPayloadSchema,
    estimatedCostCents: z.null(),
  }),
]);

export type ProposedAgentAction = z.infer<typeof proposedAgentActionSchema>;
