import { format } from 'date-fns';
import { z } from 'zod';
import { doorDashOrderItemSchema } from './command-types';

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SESSION_TURNS = 12;

export const agentSessionStatusSchema = z.enum([
  'active',
  'waiting_for_user',
  'pending_approval',
  'closed',
]);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

export const agentArtifactKindSchema = z.enum(['doordash_order', 'sandbox_event_plan', 'reminder']);
export type AgentArtifactKind = z.infer<typeof agentArtifactKindSchema>;

export const agentArtifactStatusSchema = z.enum([
  'collecting',
  'ready',
  'pending_approval',
  'scheduled',
  'completed',
  'cancelled',
  'expired',
]);
export type AgentArtifactStatus = z.infer<typeof agentArtifactStatusSchema>;

export const doorDashOrderSlotsSchema = z.object({
  restaurant: z.string().min(1).max(120).optional(),
  storeId: z.string().min(1).max(100).optional(),
  menuId: z.string().min(1).max(100).optional(),
  items: z.array(doorDashOrderItemSchema).min(1).max(30).optional(),
  deliveryAt: z.string().datetime({ offset: true }).optional(),
  deliveryAddress: z.string().min(1).max(300).optional(),
  estimatedCostCents: z.number().int().positive().max(1_000_000).optional(),
});

export const sandboxEventPlanSlotsSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  eventAt: z.string().datetime({ offset: true }).optional(),
  location: z.string().min(1).max(300).optional(),
  headcount: z.number().int().min(1).max(500).optional(),
  agenda: z.string().min(1).max(1000).optional(),
  estimatedCostCents: z.number().int().nonnegative().max(1_000_000).optional(),
});

export const reminderSlotsSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  fireAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().min(1).max(500).optional(),
});

export const artifactSlotsSchema = doorDashOrderSlotsSchema
  .extend(sandboxEventPlanSlotsSchema.shape)
  .extend(reminderSlotsSchema.shape);
export type ArtifactSlots = z.infer<typeof artifactSlotsSchema>;

const DOORDASH_REQUIRED = ['restaurant', 'deliveryAddress'] as const;
const EVENT_PLAN_REQUIRED = [
  'title',
  'eventAt',
  'location',
  'headcount',
  'agenda',
  'estimatedCostCents',
] as const;
const REMINDER_REQUIRED = ['title', 'fireAt'] as const;

export const missingSlotsFor = (kind: AgentArtifactKind, slots: ArtifactSlots): string[] => {
  const required =
    kind === 'doordash_order'
      ? DOORDASH_REQUIRED
      : kind === 'sandbox_event_plan'
        ? EVENT_PLAN_REQUIRED
        : REMINDER_REQUIRED;
  return required.filter((key) => slots[key as keyof ArtifactSlots] === undefined);
};

export const parseArtifactSlots = (
  kind: AgentArtifactKind,
  value: unknown,
): ArtifactSlots | null => {
  const schema =
    kind === 'doordash_order'
      ? doorDashOrderSlotsSchema
      : kind === 'sandbox_event_plan'
        ? sandboxEventPlanSlotsSchema
        : reminderSlotsSchema;
  const parsed = schema.safeParse(value ?? {});
  return parsed.success ? artifactSlotsSchema.parse(parsed.data) : null;
};

export const detectArtifactKind = (text: string): AgentArtifactKind | null => {
  const request = text.trim().toLowerCase();
  if (/\b(remind|reminder|nudge|ping me)\b/.test(request)) return 'reminder';
  if (/\b(doordash|food|lunch|meal|pizza|catering|restaurant|order)\b/.test(request)) {
    return 'doordash_order';
  }
  if (/\b(event|venue|offsite|party|outing|retreat|plan)\b/.test(request)) {
    return 'sandbox_event_plan';
  }
  return null;
};

export const sessionCommandKind = (text: string): 'cancel' | 'restart' | 'summary' | null => {
  const request = text.trim().toLowerCase();
  if (/^(cancel|nevermind|never mind)\.?$/.test(request)) return 'cancel';
  if (/^(start over|restart|forget that)\.?$/.test(request)) return 'restart';
  if (/^(what do you have so far|status|summary)\??$/.test(request)) return 'summary';
  return null;
};

const KIND_LABEL: Record<AgentArtifactKind, string> = {
  doordash_order: 'DoorDash order',
  sandbox_event_plan: 'event plan',
  reminder: 'reminder',
};

const SLOT_LABEL: Record<string, string> = {
  restaurant: 'Restaurant',
  items: 'Items',
  deliveryAt: 'When',
  deliveryAddress: 'Deliver to',
  estimatedCostCents: 'Maximum total',
  title: 'Title',
  eventAt: 'When',
  location: 'Where',
  headcount: 'Headcount',
  agenda: 'Agenda',
  fireAt: 'Remind at',
  note: 'Note',
};

const MISSING_LABEL: Record<string, string> = {
  restaurant: 'a restaurant',
  deliveryAddress: 'a delivery address',
  estimatedCostCents: 'a maximum total',
  title: 'a title',
  eventAt: 'a date and time',
  location: 'a location',
  headcount: 'a headcount',
  agenda: 'an agenda',
  fireAt: 'a reminder time',
};

const HIDDEN_SLOTS = new Set(['storeId', 'menuId']);

const formatWallClock = (value: string): string => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return value;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  return format(date, "EEEE, MMMM d, yyyy 'at' h:mm a");
};

const formatCents = (cents: number): string => {
  const dollars = cents / 100;
  return `$${dollars.toFixed(cents % 100 === 0 ? 0 : 2)}`;
};

const formatItems = (items: ArtifactSlots['items']): string | null => {
  if (!items || items.length === 0) return null;
  return items.map((item) => `${item.quantity}× ${item.itemName}`).join(', ');
};

const formatSlotValue = (key: string, value: unknown): string | null => {
  if (value === undefined || value === null || HIDDEN_SLOTS.has(key)) return null;
  if (key === 'items') return formatItems(value as ArtifactSlots['items']);
  if (
    (key === 'deliveryAt' || key === 'eventAt' || key === 'fireAt') &&
    typeof value === 'string'
  ) {
    return formatWallClock(value);
  }
  if (key === 'estimatedCostCents' && typeof value === 'number') return formatCents(value);
  if (key === 'headcount' && typeof value === 'number') {
    return value === 1 ? '1 person' : `${value} people`;
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return null;
};

const joinList = (items: string[]): string => {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
};

export const formatArtifactSummary = (
  artifact: {
    kind: AgentArtifactKind;
    status: AgentArtifactStatus;
    slots: ArtifactSlots;
    missingSlots: string[];
  } | null,
): string => {
  if (!artifact) return "I don't have an active draft yet. Tell me what you'd like to plan.";

  const known = Object.entries(artifact.slots).flatMap(([key, value]) => {
    const formatted = formatSlotValue(key, value);
    const label = SLOT_LABEL[key];
    return formatted && label ? [`• ${label}: ${formatted}`] : [];
  });
  const missing = artifact.missingSlots.map((slot) => MISSING_LABEL[slot] ?? slot);
  const lines = [`Here's what I have so far for this ${KIND_LABEL[artifact.kind]}:`, ''];
  if (known.length > 0) {
    lines.push(...known);
  } else {
    lines.push("I haven't saved any details yet.");
  }
  lines.push('');
  if (missing.length > 0) {
    lines.push(`Still need ${joinList(missing)}.`);
  } else if (artifact.status === 'pending_approval') {
    lines.push('This is waiting on your approval. Nothing has been ordered or scheduled yet.');
  } else if (artifact.status === 'scheduled') {
    lines.push('This reminder is scheduled.');
  } else {
    lines.push('I have the details I need to propose the next step.');
  }
  return lines.join('\n');
};
