import { z } from 'zod';

export const agentActionKindSchema = z.enum([
  'set_default_budget',
  'set_celebration_channel',
  'sandbox_food_order',
  'sandbox_event_plan',
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

export const sandboxEventPlanPayloadSchema = z.object({
  title: z.string().min(1).max(120),
  eventAt: z.string().datetime({ offset: true }),
  location: z.string().min(1).max(300),
  headcount: z.number().int().min(1).max(500),
  agenda: z.string().min(1).max(1000),
  estimatedCostCents: z.number().int().nonnegative().max(1_000_000),
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
    kind: z.literal('sandbox_event_plan'),
    summary: z.string().min(1).max(160),
    payload: sandboxEventPlanPayloadSchema,
    estimatedCostCents: z.number().int().nonnegative(),
  }),
]);

export type ProposedAgentAction = z.infer<typeof proposedAgentActionSchema>;
