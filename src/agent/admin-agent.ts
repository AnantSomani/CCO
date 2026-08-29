import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { type AgentArtifact, upsertOpenArtifact } from '@/db/queries/agent-sessions';
import { listOptedOut, listPeople } from '@/db/queries/people';
import type { Workspace } from '@/db/queries/workspaces';
import {
  buildDoorDashIntent,
  type DdCliClient,
  type DoorDashItemDetails,
  type DoorDashMenu,
  describeDdCliError,
} from '@/integrations/doordash/dd-cli-client';
import {
  applyDefaultSingleChoices,
  arrangeSelectedOptions,
  itemOptionIds,
  missingRequiredOptionNames,
  normalizeItemDetails,
  selectedOptionIds,
  summarizeItemDetails,
} from '@/integrations/doordash/item-details';
import { summarizeMenuItemPrice } from '@/integrations/doordash/prices';
import {
  type AddressCandidate,
  addressLooksLike,
  geocodeUsAddress,
  matchSavedAddress,
  pickAddressCandidate,
  savedAddressId,
  savedAddressLabel,
} from '@/integrations/doordash/resolve-address';
import { err, ok, type Result } from '@/lib/result';
import { describeProposalError, honestAdminReply } from './admin-reply';
import {
  doorDashOrderPreviewPayloadSchema,
  type ProposedAgentAction,
  proposedAgentActionSchema,
  sandboxEventPlanPayloadSchema,
  sandboxFoodOrderPayloadSchema,
  scheduleReminderPayloadSchema,
} from './command-types';
import { AGENT_MAX_TOKENS, AGENT_MODEL, AGENT_TIMEOUT_MS } from './model';
import { type ArtifactSlots, agentArtifactKindSchema, parseArtifactSlots } from './session-types';

const ADMIN_AGENT_TIMEOUT_MS = Math.max(AGENT_TIMEOUT_MS, 60_000);
const MAX_ROUNDS = 7;
const MAX_ACTIONS = 3;
const MAX_RESPONSE_CHARS = 700;

const TOOL_GET_WORKSPACE_SETTINGS = 'get_workspace_settings' as const;
const TOOL_LIST_OPTED_OUT = 'list_opted_out_people' as const;
const TOOL_LIST_ROSTER_SUMMARY = 'list_roster_summary' as const;
const TOOL_PROPOSE_SET_BUDGET = 'propose_set_default_budget' as const;
const TOOL_PROPOSE_SET_CHANNEL = 'propose_set_celebration_channel' as const;
const TOOL_PROPOSE_FOOD_ORDER = 'propose_sandbox_food_order' as const;
const TOOL_DOORDASH_SEARCH = 'doordash_search_restaurants' as const;
const TOOL_DOORDASH_MENU = 'doordash_get_menu' as const;
const TOOL_DOORDASH_ITEM_DETAILS = 'doordash_get_item_details' as const;
const TOOL_PROPOSE_DOORDASH_PREVIEW = 'propose_doordash_order_preview' as const;
const TOOL_PROPOSE_EVENT_PLAN = 'propose_sandbox_event_plan' as const;
const TOOL_UPDATE_ARTIFACT = 'update_artifact_slots' as const;
const TOOL_PROPOSE_REMINDER = 'propose_reminder' as const;
const TOOL_FINALIZE = 'finalize_response' as const;

const SYSTEM_PROMPT = `You are Confetti's admin copilot inside Slack. Help an authorized workspace admin understand roster state, configure Confetti, and plan team moments.

# Safety model
- Read-only tools execute immediately.
- Every mutation is only a proposal. A human must approve it in Slack before execution.
- Sandbox food orders and event plans never contact vendors, reserve anything, or spend money.
- DoorDash tools may search live restaurants and menus. A DoorDash preview proposal still requires Slack approval; approval may create a cart and retrieve a quote, but it can never submit an order or charge a payment method.
- Never claim an action completed. Say that it was prepared and requires approval.
- Never invent a channel, dollar amount, address, date, headcount, or vendor. Ask for missing details.
- When a tool returns a support code, repeat its stated explanation and code without inventing a cause or blaming user input.
- The workspace budget is the maximum TOTAL cost for one event or action. It is never a per-person amount and must not be multiplied by headcount.
- Never expose birthdays, start dates, email addresses, or other personal roster data.

# How to work
- Use context tools when they materially help.
- For a DoorDash preview, search first, retrieve the selected restaurant's menu, then call doordash_get_item_details for each chosen item. If this turn already reloaded DoorDash discovery from the draft, use those exact IDs and propose without searching again. Required extras may use title instead of name and nest under the chosen size (crust, sauce, toppings). A flat list of chosen option names is enough; Confetti will nest them. If a required group has exactly one choice, include that id. If required options are missing, ask the user to pick them. Propose only exact returned IDs and item names. Never invent option IDs.
- Compare only priceCents to defaultPerEventBudgetCents. Example: 2498 cents is $24.98 and is under a 5000-cent ($50) budget. Never say a cheaper item exceeds the budget.
- If restaurant, item, address, and time are known, call propose_doordash_order_preview in this turn. Use the workspace budget as estimatedCostCents unless the user named a lower max. Do not ask for a maximum.
- Never say you queued, submitted, or prepared an approval card unless propose_doordash_order_preview returned accepted in this turn. The Slack card is the only approval. Approval creates a cart preview; it never places an order.
- If propose_doordash_order_preview failed, say which options are still missing. Never blame DoorDash, invent a validation outage, tell the user to order on DoorDash, or mention Confetti support.
- Do not repeat the full order summary. Ask at most one question, or propose.
- If the user typed a delivery address, resolve it with DoorDash address find or a matching saved address. Search near those coordinates. Never tell the user to change a DoorDash default address themselves. Never claim a typed address was searched until resolution succeeded.
- When the user supplies draft fields (address, date, time, headcount, restaurant), call update_artifact_slots and ask only for missing slots. Do not call DoorDash search or menu tools until the user has named a restaurant or search query.
- Use a proposal tool only when the user explicitly asks for that action and every required field is present in this conversation or the persisted draft.
- Ask only for missing or ambiguous slots. Restate resolved slots before proposing.
- Persist newly provided fields with update_artifact_slots before asking the next question.
- If an active draft exists and the user starts a different kind of task, ask them to say "start over" instead of replacing it.
- Never invent store IDs, item IDs, dates, times, or reminder fire times.
- Respect the workspace budget for sandbox actions.
- Keep the final response concise and call finalize_response exactly once.
`;

const listRosterSummaryInputSchema = z.object({
  limit: z.number().int().min(1).max(10).optional(),
});

const proposeSetBudgetInputSchema = z.object({
  amount_usd: z.number().positive().max(10_000),
  summary: z.string().min(1).max(160),
});

const proposeSetChannelInputSchema = z.object({
  channel_reference: z.string().min(1).max(100),
  summary: z.string().min(1).max(160),
});

const proposeFoodOrderInputSchema = sandboxFoodOrderPayloadSchema
  .extend({ summary: z.string().min(1).max(160) })
  .transform((value) => ({
    restaurant: value.restaurant,
    itemsDescription: value.itemsDescription,
    headcount: value.headcount,
    deliveryAt: value.deliveryAt,
    deliveryAddress: value.deliveryAddress,
    estimatedCostCents: value.estimatedCostCents,
    summary: value.summary,
  }));

const doorDashSearchInputSchema = z.object({
  query: z.string().min(1).max(120),
  address: z.string().min(1).max(300).optional(),
});

const doorDashMenuInputSchema = z.object({
  store_id: z.string().min(1).max(100),
});

const doorDashItemDetailsInputSchema = z.object({
  store_id: z.string().min(1).max(100),
  menu_id: z.string().min(1).max(100),
  item_id: z.string().min(1).max(100),
});

const proposeDoorDashPreviewInputSchema = doorDashOrderPreviewPayloadSchema.extend({
  summary: z.string().min(1).max(160),
});

const proposeEventPlanInputSchema = sandboxEventPlanPayloadSchema
  .extend({ summary: z.string().min(1).max(160) })
  .transform((value) => ({
    title: value.title,
    eventAt: value.eventAt,
    location: value.location,
    headcount: value.headcount,
    agenda: value.agenda,
    estimatedCostCents: value.estimatedCostCents,
    summary: value.summary,
  }));

const proposeReminderInputSchema = scheduleReminderPayloadSchema.extend({
  summary: z.string().min(1).max(160),
});

const updateArtifactInputSchema = z.object({
  kind: agentArtifactKindSchema,
  slots: z.record(z.string(), z.unknown()),
  replace_existing: z.boolean().optional(),
});

const finalizeResponseInputSchema = z.object({
  reply_text: z.string().min(1).max(MAX_RESPONSE_CHARS),
});

const TOOLS: Anthropic.Tool[] = [
  {
    name: TOOL_GET_WORKSPACE_SETTINGS,
    description:
      'Read the workspace team name, celebration channel, total per-event budget, and timezone.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: TOOL_LIST_OPTED_OUT,
    description: 'List the names of teammates currently opted out of celebrations.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: TOOL_LIST_ROSTER_SUMMARY,
    description:
      'Get a privacy-safe roster summary with total count and a sample of names, teams, and roles.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
  },
  {
    name: TOOL_PROPOSE_SET_BUDGET,
    description:
      'Propose changing the default budget. Only use when the user explicitly supplied the exact amount.',
    input_schema: {
      type: 'object',
      properties: {
        amount_usd: { type: 'number', minimum: 0.01, maximum: 10_000 },
        summary: { type: 'string', maxLength: 160 },
      },
      required: ['amount_usd', 'summary'],
    },
  },
  {
    name: TOOL_PROPOSE_SET_CHANNEL,
    description:
      'Propose changing the celebration channel. channel_reference must be the literal Slack channel mention or ID in the request.',
    input_schema: {
      type: 'object',
      properties: {
        channel_reference: { type: 'string', maxLength: 100 },
        summary: { type: 'string', maxLength: 160 },
      },
      required: ['channel_reference', 'summary'],
    },
  },
  {
    name: TOOL_PROPOSE_FOOD_ORDER,
    description:
      'Prepare a sandbox-only food order requiring approval. Never use without restaurant, items, headcount, ISO delivery time, delivery address, and estimate.',
    input_schema: {
      type: 'object',
      properties: {
        restaurant: { type: 'string', maxLength: 120 },
        itemsDescription: { type: 'string', maxLength: 500 },
        headcount: { type: 'integer', minimum: 1, maximum: 500 },
        deliveryAt: { type: 'string', format: 'date-time' },
        deliveryAddress: { type: 'string', maxLength: 300 },
        estimatedCostCents: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        summary: { type: 'string', maxLength: 160 },
      },
      required: [
        'restaurant',
        'itemsDescription',
        'headcount',
        'deliveryAt',
        'deliveryAddress',
        'estimatedCostCents',
        'summary',
      ],
    },
  },
  {
    name: TOOL_DOORDASH_SEARCH,
    description:
      'Search live DoorDash restaurants. If the user supplied a delivery address, pass it as address so Confetti can resolve it with address find. Use before requesting a menu.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120 },
        address: { type: 'string', minLength: 1, maxLength: 300 },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_DOORDASH_MENU,
    description:
      'Retrieve the live menu for a restaurant returned by doordash_search_restaurants. Use exact returned item IDs and names.',
    input_schema: {
      type: 'object',
      properties: {
        store_id: { type: 'string', minLength: 1, maxLength: 100 },
      },
      required: ['store_id'],
    },
  },
  {
    name: TOOL_DOORDASH_ITEM_DETAILS,
    description:
      'Retrieve required customizations for a menu item. Call this after the user picks an item and before proposing a DoorDash preview.',
    input_schema: {
      type: 'object',
      properties: {
        store_id: { type: 'string', minLength: 1, maxLength: 100 },
        menu_id: { type: 'string', minLength: 1, maxLength: 100 },
        item_id: { type: 'string', minLength: 1, maxLength: 100 },
      },
      required: ['store_id', 'menu_id', 'item_id'],
    },
  },
  {
    name: TOOL_PROPOSE_DOORDASH_PREVIEW,
    description:
      'Prepare a DoorDash cart-and-quote preview requiring Slack approval. This cannot submit or charge an order. Use only exact IDs and names returned by the discovery tools.',
    input_schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string', maxLength: 100 },
        restaurant: { type: 'string', maxLength: 120 },
        menuId: { type: 'string', maxLength: 100 },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string', maxLength: 100 },
              itemName: { type: 'string', maxLength: 200 },
              quantity: { type: 'integer', minimum: 1, maximum: 100 },
              nestedOptions: { type: 'array', maxItems: 20, items: { type: 'object' } },
            },
            required: ['itemId', 'itemName', 'quantity'],
          },
        },
        deliveryAt: { type: 'string', format: 'date-time' },
        deliveryAddress: { type: 'string', maxLength: 300 },
        estimatedCostCents: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        summary: { type: 'string', maxLength: 160 },
      },
      required: [
        'storeId',
        'restaurant',
        'menuId',
        'items',
        'deliveryAddress',
        'estimatedCostCents',
        'summary',
      ],
    },
  },
  {
    name: TOOL_PROPOSE_EVENT_PLAN,
    description:
      'Prepare a sandbox-only event plan requiring approval. Never use without title, ISO event time, location, headcount, agenda, and estimate.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 120 },
        eventAt: { type: 'string', format: 'date-time' },
        location: { type: 'string', maxLength: 300 },
        headcount: { type: 'integer', minimum: 1, maximum: 500 },
        agenda: { type: 'string', maxLength: 1000 },
        estimatedCostCents: { type: 'integer', minimum: 0, maximum: 1_000_000 },
        summary: { type: 'string', maxLength: 160 },
      },
      required: [
        'title',
        'eventAt',
        'location',
        'headcount',
        'agenda',
        'estimatedCostCents',
        'summary',
      ],
    },
  },
  {
    name: TOOL_UPDATE_ARTIFACT,
    description:
      'Save confirmed fields from this conversation onto the active draft. Use after the user provides a date, time, restaurant, item, address, budget, or reminder time.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['doordash_order', 'sandbox_event_plan', 'reminder'],
        },
        slots: { type: 'object' },
        replace_existing: { type: 'boolean' },
      },
      required: ['kind', 'slots'],
    },
  },
  {
    name: TOOL_PROPOSE_REMINDER,
    description:
      'Propose a one-time reminder DM after Slack approval. fireAt must be an ISO timestamp the user explicitly provided.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 160 },
        fireAt: { type: 'string', format: 'date-time' },
        note: { type: 'string', maxLength: 500 },
        artifactId: { type: 'string' },
        summary: { type: 'string', maxLength: 160 },
      },
      required: ['title', 'fireAt', 'summary'],
    },
  },
  {
    name: TOOL_FINALIZE,
    description: 'Return the exact concise Slack response to the admin.',
    input_schema: {
      type: 'object',
      properties: { reply_text: { type: 'string', maxLength: MAX_RESPONSE_CHARS } },
      required: ['reply_text'],
    },
  },
];

type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type AdminAgentToolCall = { name: string; input: unknown };

export type AdminAgentSessionContext = {
  id: string;
  turns: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>;
  artifact: AgentArtifact | null;
};

export type RunAdminAgentArgs = {
  anthropic: Anthropic;
  db: Db;
  doorDash?: DdCliClient;
  workspace: Workspace;
  rawText: string;
  userId: string;
  log: Logger;
  session?: AdminAgentSessionContext;
  geocodeAddress?: typeof geocodeUsAddress;
};

export type AdminAgentResult = {
  replyText: string;
  proposedActions: ProposedAgentAction[];
  toolCalls: AdminAgentToolCall[];
  model: string;
  rounds: number;
};

export type RunAdminAgent = (args: RunAdminAgentArgs) => Promise<Result<AdminAgentResult, string>>;

type DoorDashDiscoveryState = {
  deliveryAddress: string | null;
  placeId: string | null;
  addressId: string | null;
  stores: Map<string, { name: string }>;
  menus: Map<string, DoorDashMenu>;
  itemDetails: Map<string, DoorDashItemDetails>;
};

const doorDashToolError = (operation: string, error: string): string =>
  `${operation} failed. ${describeDdCliError(error)}`;

export const runAdminAgent: RunAdminAgent = async (args) => {
  const conversation: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        `Workspace: ${args.workspace.slackTeamName}`,
        `Workspace timezone: ${args.workspace.timezone}`,
        `Workspace total per-event budget cents: ${args.workspace.defaultBudgetCents}`,
        `Use ${args.workspace.defaultBudgetCents} as DoorDash estimatedCostCents unless the user named a lower maximum. Do not ask for a maximum.`,
        `Requesting Slack user: ${args.userId}`,
        args.session
          ? `Active draft: ${args.session.artifact ? `${args.session.artifact.kind} status=${args.session.artifact.status} slots=${JSON.stringify(args.session.artifact.slots)} missing=${args.session.artifact.missingSlots.join(',')}` : 'none'}`
          : 'Active draft: none',
        args.session && args.session.turns.length > 0
          ? `Prior turns:\n${args.session.turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n')}`
          : 'Prior turns: none',
        `Request: ${args.rawText.trim()}`,
      ].join('\n'),
    },
  ];
  const proposedActions: ProposedAgentAction[] = [];
  const toolCalls: AdminAgentToolCall[] = [];
  const doorDashDiscovery: DoorDashDiscoveryState = {
    deliveryAddress: null,
    placeId: null,
    addressId: null,
    stores: new Map(),
    menus: new Map(),
    itemDetails: new Map(),
  };
  const sessionState: { artifact: AgentArtifact | null } = {
    artifact: args.session?.artifact ?? null,
  };
  let lastProposalError: string | null = null;
  if (args.doorDash) {
    await hydrateDoorDashDiscovery(args, doorDashDiscovery, sessionState);
  }
  const reloadedDiscovery = summarizeReloadedDoorDashDiscovery(
    doorDashDiscovery,
    sessionState.artifact,
  );
  if (reloadedDiscovery && conversation[0] && typeof conversation[0].content === 'string') {
    conversation[0].content += `\n${reloadedDiscovery}`;
  }
  const groundingText = [
    ...(args.session?.turns.map((turn) => turn.text) ?? []),
    args.rawText,
  ].join('\n');

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let response: Anthropic.Message;
    try {
      response = await callWithTimeout(args.anthropic, {
        model: AGENT_MODEL,
        max_tokens: AGENT_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        tool_choice:
          round === MAX_ROUNDS ? { type: 'tool', name: TOOL_FINALIZE } : { type: 'auto' },
        messages: conversation,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.log.error('admin agent api call failed', {
        workspaceId: args.workspace.id,
        round,
        error: message,
      });
      return err(message);
    }

    conversation.push({
      role: 'assistant',
      content: response.content as unknown as Anthropic.ContentBlockParam[],
    });
    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      conversation.push({
        role: 'user',
        content: 'Use the available tools, then call finalize_response.',
      });
      continue;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let finalReply: string | null = null;

    for (const toolUse of toolUses) {
      toolCalls.push({ name: toolUse.name, input: toolUse.input });
      const result = await runTool(
        args,
        toolUse,
        proposedActions,
        doorDashDiscovery,
        sessionState,
        groundingText,
      );
      if (toolUse.name === TOOL_FINALIZE && result.ok) finalReply = result.value;
      if (!result.ok && toolUse.name.startsWith('propose_')) lastProposalError = result.error;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.ok ? result.value : result.error,
        ...(result.ok ? {} : { is_error: true }),
      });
    }

    if (finalReply) {
      return ok({
        replyText: honestAdminReply(finalReply, proposedActions.length, lastProposalError),
        proposedActions,
        toolCalls,
        model: AGENT_MODEL,
        rounds: round,
      });
    }

    conversation.push({ role: 'user', content: toolResults });
  }

  return ok({
    replyText: lastProposalError
      ? `I could not prepare an approval card yet. ${describeProposalError(lastProposalError)}`
      : 'I could not finish that turn. Your draft is still here. Say `what do you have so far` or send the next detail.',
    proposedActions,
    toolCalls,
    model: AGENT_MODEL,
    rounds: MAX_ROUNDS,
  });
};

const runTool = async (
  args: RunAdminAgentArgs,
  toolUse: Anthropic.ToolUseBlock,
  proposedActions: ProposedAgentAction[],
  doorDashDiscovery: DoorDashDiscoveryState,
  sessionState: { artifact: AgentArtifact | null },
  groundingText: string,
): Promise<Result<string, string>> => {
  switch (toolUse.name) {
    case TOOL_GET_WORKSPACE_SETTINGS:
      return ok(
        JSON.stringify({
          teamName: args.workspace.slackTeamName,
          celebrationChannelId: args.workspace.celebrationChannelId,
          defaultPerEventBudgetCents: args.workspace.defaultBudgetCents,
          budgetScope: 'per_event_total',
          timezone: args.workspace.timezone,
        }),
      );

    case TOOL_LIST_OPTED_OUT: {
      const rows = await listOptedOut(args.db, args.workspace.id);
      return ok(JSON.stringify({ optedOutNames: rows.map((row) => row.name) }));
    }

    case TOOL_LIST_ROSTER_SUMMARY: {
      const parsed = listRosterSummaryInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('limit must be an integer from 1 to 10');
      const limit = parsed.data.limit ?? 5;
      const people = await listPeople(args.db, args.workspace.id);
      return ok(
        JSON.stringify({
          totalPeople: people.length,
          optedOutCount: people.filter((person) => person.optedOut).length,
          sample: people.slice(0, limit).map((person) => ({
            name: person.name,
            team: person.team,
            role: person.role,
            optedOut: person.optedOut,
          })),
        }),
      );
    }

    case TOOL_PROPOSE_SET_BUDGET: {
      const parsed = proposeSetBudgetInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('invalid budget proposal');
      const amountCents = Math.round(parsed.data.amount_usd * 100);
      if (!requestContainsDollarAmount(groundingText, amountCents)) {
        return err('the proposed budget amount was not explicitly present in the user request');
      }
      return addAction(proposedActions, {
        kind: 'set_default_budget',
        summary: parsed.data.summary,
        payload: { amountCents },
        estimatedCostCents: null,
      });
    }

    case TOOL_PROPOSE_SET_CHANNEL: {
      const parsed = proposeSetChannelInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('invalid channel proposal');
      const channelId = parseChannelId(parsed.data.channel_reference);
      if (!channelId || !args.rawText.includes(channelId)) {
        return err('the proposed channel ID was not explicitly present in the user request');
      }
      return addAction(proposedActions, {
        kind: 'set_celebration_channel',
        summary: parsed.data.summary,
        payload: { channelId },
        estimatedCostCents: null,
      });
    }

    case TOOL_PROPOSE_FOOD_ORDER: {
      const parsed = proposeFoodOrderInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('food-order proposal is missing required details');
      if (parsed.data.estimatedCostCents > args.workspace.defaultBudgetCents) {
        return err('food-order estimate exceeds the workspace budget');
      }
      if (
        !requestContainsPhrase(groundingText, parsed.data.restaurant) ||
        !requestContainsPhrase(groundingText, parsed.data.deliveryAddress) ||
        !requestContainsNumber(groundingText, parsed.data.headcount) ||
        !requestContainsDollarAmount(groundingText, parsed.data.estimatedCostCents)
      ) {
        return err(
          'restaurant, address, headcount, and estimate must be explicitly grounded in the user request',
        );
      }
      return addAction(proposedActions, {
        kind: 'sandbox_food_order',
        summary: parsed.data.summary,
        payload: {
          restaurant: parsed.data.restaurant,
          itemsDescription: parsed.data.itemsDescription,
          headcount: parsed.data.headcount,
          deliveryAt: parsed.data.deliveryAt,
          deliveryAddress: parsed.data.deliveryAddress,
          estimatedCostCents: parsed.data.estimatedCostCents,
        },
        estimatedCostCents: parsed.data.estimatedCostCents,
      });
    }

    case TOOL_DOORDASH_SEARCH: {
      if (!args.doorDash) return err('DoorDash preview is disabled for this environment');
      const parsed = doorDashSearchInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('DoorDash search query is invalid');
      const intent = buildDoorDashIntent(
        'Help the workspace admin preview a team food order',
        args.rawText,
      );
      const requestedAddress =
        parsed.data.address ??
        (typeof sessionState.artifact?.slots.deliveryAddress === 'string'
          ? sessionState.artifact.slots.deliveryAddress
          : null);
      const resolved = await resolveSearchLocation(
        args.doorDash,
        requestedAddress,
        intent,
        args.geocodeAddress ?? geocodeUsAddress,
      );
      if (!resolved.ok) return resolved;
      if (resolved.value.kind === 'ambiguous') {
        return ok(
          JSON.stringify({
            needsAddressChoice: true,
            message:
              'I found more than one matching address. Ask the user which one to use. I have not searched restaurants yet.',
            candidates: resolved.value.candidates,
          }),
        );
      }
      const location = resolved.value.location;
      const found = await args.doorDash.searchRestaurants({
        query: parsed.data.query,
        lat: location.lat,
        lng: location.lng,
        limit: 5,
        intent,
      });
      if (!found.ok) {
        return err(doorDashToolError('DoorDash restaurant search', found.error));
      }
      doorDashDiscovery.deliveryAddress = location.printableAddress;
      doorDashDiscovery.placeId = location.placeId ?? null;
      doorDashDiscovery.addressId = location.addressId ?? null;
      for (const store of found.value.stores) {
        doorDashDiscovery.stores.set(store.store_id, { name: store.name });
      }
      await persistDoorDashDraft(args, sessionState, {
        deliveryAddress: location.printableAddress,
      });
      return ok(
        JSON.stringify({
          deliveryAddress: location.printableAddress,
          addressSource: location.source,
          searchedTypedAddress: requestedAddress !== null,
          stores: found.value.stores.map((store) => ({
            storeId: store.store_id,
            name: store.name,
            description: store.description,
            distance: store.distance,
            deliveryTime: store.delivery_time,
          })),
        }),
      );
    }

    case TOOL_DOORDASH_MENU: {
      if (!args.doorDash) return err('DoorDash preview is disabled for this environment');
      const parsed = doorDashMenuInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('DoorDash store ID is invalid');
      if (!doorDashDiscovery.stores.has(parsed.data.store_id)) {
        return err('restaurant must come from this request’s DoorDash search results');
      }
      const menu = await args.doorDash.getMenu({
        storeId: parsed.data.store_id,
        intent: buildDoorDashIntent(
          'Help the workspace admin choose exact team lunch items',
          args.rawText,
        ),
      });
      if (!menu.ok) return err(doorDashToolError('DoorDash menu lookup', menu.error));
      doorDashDiscovery.menus.set(parsed.data.store_id, menu.value);
      const store = doorDashDiscovery.stores.get(parsed.data.store_id);
      await persistDoorDashDraft(args, sessionState, {
        storeId: parsed.data.store_id,
        menuId: menu.value.menu_id,
        ...(store ? { restaurant: store.name } : {}),
      });
      return ok(
        JSON.stringify({
          storeId: parsed.data.store_id,
          menuId: menu.value.menu_id,
          budgetCents: args.workspace.defaultBudgetCents,
          items: menu.value.items.slice(0, 100).map((item) => ({
            ...item,
            ...summarizeMenuItemPrice(item.price, item.price_display_string),
          })),
          truncated: menu.value.items.length > 100,
        }),
      );
    }

    case TOOL_DOORDASH_ITEM_DETAILS: {
      if (!args.doorDash) return err('DoorDash preview is disabled for this environment');
      const parsed = doorDashItemDetailsInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('DoorDash item details request is invalid');
      if (!doorDashDiscovery.stores.has(parsed.data.store_id)) {
        return err('restaurant must come from this request’s DoorDash search results');
      }
      const menu = doorDashDiscovery.menus.get(parsed.data.store_id);
      if (!menu || menu.menu_id !== parsed.data.menu_id) {
        return err('menu must come from this request’s DoorDash menu lookup');
      }
      if (!menu.items.some((item) => item.item_id === parsed.data.item_id)) {
        return err('item must come from this request’s DoorDash menu lookup');
      }
      const details = await args.doorDash.getItemDetails({
        storeId: parsed.data.store_id,
        menuId: parsed.data.menu_id,
        itemId: parsed.data.item_id,
        intent: buildDoorDashIntent(
          'Help the workspace admin choose required DoorDash item options',
          args.rawText,
        ),
      });
      if (!details.ok) return err(doorDashToolError('DoorDash item details', details.error));
      doorDashDiscovery.itemDetails.set(parsed.data.item_id, details.value);
      return ok(JSON.stringify(summarizeItemDetails(normalizeItemDetails(details.value))));
    }

    case TOOL_PROPOSE_DOORDASH_PREVIEW: {
      const parsed = proposeDoorDashPreviewInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('DoorDash preview proposal is missing required details');
      if (!args.doorDash) return err('DoorDash preview is disabled for this environment');
      if (parsed.data.estimatedCostCents > args.workspace.defaultBudgetCents) {
        return err('DoorDash preview estimate exceeds the workspace budget');
      }
      const usesWorkspaceBudget =
        parsed.data.estimatedCostCents === args.workspace.defaultBudgetCents;
      if (
        !usesWorkspaceBudget &&
        !requestContainsDollarAmount(groundingText, parsed.data.estimatedCostCents)
      ) {
        return err('the DoorDash maximum estimate must be explicitly present in the user request');
      }
      if (
        !doorDashDiscovery.stores.has(parsed.data.storeId) ||
        !doorDashDiscovery.menus.has(parsed.data.storeId)
      ) {
        await hydrateDoorDashDiscovery(args, doorDashDiscovery, sessionState);
      }
      const store = doorDashDiscovery.stores.get(parsed.data.storeId);
      const menu = doorDashDiscovery.menus.get(parsed.data.storeId);
      if (!store || !menu || menu.menu_id !== parsed.data.menuId) {
        return err('DoorDash restaurant and menu must come from this request’s discovery results');
      }
      if (store.name !== parsed.data.restaurant) {
        return err('DoorDash restaurant name does not match the selected store');
      }
      const resolvedAddress = doorDashDiscovery.deliveryAddress;
      if (
        resolvedAddress === null ||
        (parsed.data.deliveryAddress !== resolvedAddress &&
          !addressLooksLike(resolvedAddress, parsed.data.deliveryAddress))
      ) {
        return err('delivery address must match the address Confetti resolved for this search');
      }
      for (const requestedItem of parsed.data.items) {
        const discoveredItem = menu.items.find((item) => item.item_id === requestedItem.itemId);
        if (!discoveredItem || discoveredItem.name !== requestedItem.itemName) {
          return err('every DoorDash item must exactly match the discovered menu');
        }
        const details = await loadItemDetails(
          args.doorDash,
          doorDashDiscovery,
          parsed.data.storeId,
          parsed.data.menuId,
          requestedItem.itemId,
          args.rawText,
        );
        if (!details.ok) return details;
        const nestedOptions = applyDefaultSingleChoices(
          details.value,
          arrangeSelectedOptions(details.value, requestedItem.nestedOptions),
        );
        if (nestedOptions) requestedItem.nestedOptions = nestedOptions;
        const missing = missingRequiredOptionNames(details.value, nestedOptions);
        if (missing.length > 0) {
          await persistDoorDashDraft(args, sessionState, {
            storeId: parsed.data.storeId,
            restaurant: parsed.data.restaurant,
            menuId: parsed.data.menuId,
            items: parsed.data.items,
            deliveryAddress: resolvedAddress,
            ...(parsed.data.deliveryAt ? { deliveryAt: parsed.data.deliveryAt } : {}),
          });
          return err(
            `Ask the user to pick required options for ${requestedItem.itemName}: ${missing.join(', ')}. Do not guess.`,
          );
        }
        if (!nestedOptionIdsWereDiscovered(nestedOptions, details.value.ids)) {
          return err('DoorDash item customizations must exactly match the discovered item details');
        }
      }
      await persistDoorDashDraft(args, sessionState, {
        storeId: parsed.data.storeId,
        restaurant: parsed.data.restaurant,
        menuId: parsed.data.menuId,
        items: parsed.data.items,
        deliveryAddress: resolvedAddress,
        estimatedCostCents: parsed.data.estimatedCostCents,
        ...(parsed.data.deliveryAt ? { deliveryAt: parsed.data.deliveryAt } : {}),
      });
      return addAction(proposedActions, {
        kind: 'doordash_order_preview',
        summary: parsed.data.summary,
        payload: {
          storeId: parsed.data.storeId,
          restaurant: parsed.data.restaurant,
          menuId: parsed.data.menuId,
          items: parsed.data.items,
          deliveryAt: parsed.data.deliveryAt,
          deliveryAddress: resolvedAddress,
          placeId: doorDashDiscovery.placeId ?? undefined,
          addressId: doorDashDiscovery.addressId ?? undefined,
          estimatedCostCents: parsed.data.estimatedCostCents,
        },
        estimatedCostCents: parsed.data.estimatedCostCents,
      });
    }

    case TOOL_PROPOSE_EVENT_PLAN: {
      const parsed = proposeEventPlanInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('event-plan proposal is missing required details');
      if (parsed.data.estimatedCostCents > args.workspace.defaultBudgetCents) {
        return err('event-plan estimate exceeds the workspace budget');
      }
      if (
        !requestContainsPhrase(groundingText, parsed.data.title) ||
        !requestContainsPhrase(groundingText, parsed.data.location) ||
        !requestContainsNumber(groundingText, parsed.data.headcount) ||
        !requestContainsDollarAmount(groundingText, parsed.data.estimatedCostCents)
      ) {
        return err(
          'title, location, headcount, and estimate must be explicitly grounded in the user request',
        );
      }
      return addAction(proposedActions, {
        kind: 'sandbox_event_plan',
        summary: parsed.data.summary,
        payload: {
          title: parsed.data.title,
          eventAt: parsed.data.eventAt,
          location: parsed.data.location,
          headcount: parsed.data.headcount,
          agenda: parsed.data.agenda,
          estimatedCostCents: parsed.data.estimatedCostCents,
        },
        estimatedCostCents: parsed.data.estimatedCostCents,
      });
    }

    case TOOL_UPDATE_ARTIFACT: {
      if (!args.session) return err('conversation memory is unavailable for this request');
      const parsed = updateArtifactInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('artifact update is invalid');
      const slots = parseArtifactSlots(parsed.data.kind, parsed.data.slots);
      if (!slots) return err('artifact slots failed validation');
      const existing = sessionState.artifact;
      if (existing && existing.kind !== parsed.data.kind && !parsed.data.replace_existing) {
        return err(
          `An active ${existing.kind} draft already exists. Ask the user to say "start over" before replacing it.`,
        );
      }
      const artifact = await upsertOpenArtifact(args.db, {
        sessionId: args.session.id,
        workspaceId: args.workspace.id,
        kind: parsed.data.kind,
        slots,
      });
      sessionState.artifact = artifact;
      return ok(
        JSON.stringify({
          kind: artifact.kind,
          status: artifact.status,
          slots: artifact.slots,
          missingSlots: artifact.missingSlots,
        }),
      );
    }

    case TOOL_PROPOSE_REMINDER: {
      const parsed = proposeReminderInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('reminder proposal is missing required details');
      if (
        !requestContainsPhrase(groundingText, parsed.data.title) ||
        !requestContainsPhrase(groundingText, parsed.data.fireAt)
      ) {
        return err('reminder title and fire time must be explicitly grounded in this conversation');
      }
      if (args.session) {
        const artifact = await upsertOpenArtifact(args.db, {
          sessionId: args.session.id,
          workspaceId: args.workspace.id,
          kind: 'reminder',
          slots: {
            title: parsed.data.title,
            fireAt: parsed.data.fireAt,
            ...(parsed.data.note ? { note: parsed.data.note } : {}),
          },
        });
        sessionState.artifact = artifact;
      }
      return addAction(proposedActions, {
        kind: 'schedule_reminder',
        summary: parsed.data.summary,
        payload: {
          title: parsed.data.title,
          fireAt: parsed.data.fireAt,
          note: parsed.data.note,
          artifactId: sessionState.artifact?.id,
        },
        estimatedCostCents: null,
      });
    }

    case TOOL_FINALIZE: {
      const parsed = finalizeResponseInputSchema.safeParse(toolUse.input);
      if (parsed.success) return ok(parsed.data.reply_text);
      const raw =
        toolUse.input && typeof toolUse.input === 'object' && 'reply_text' in toolUse.input
          ? String((toolUse.input as { reply_text?: unknown }).reply_text ?? '')
          : '';
      const trimmed = raw.trim().slice(0, MAX_RESPONSE_CHARS);
      return trimmed ? ok(trimmed) : err('invalid final response');
    }

    default:
      return err(`unknown tool: ${toolUse.name}`);
  }
};

const addAction = (
  actions: ProposedAgentAction[],
  candidate: ProposedAgentAction,
): Result<string, string> => {
  const parsed = proposedAgentActionSchema.safeParse(candidate);
  if (!parsed.success) return err('proposed action failed validation');
  if (actions.length >= MAX_ACTIONS)
    return err(`a request may propose at most ${MAX_ACTIONS} actions`);
  const serialized = JSON.stringify(parsed.data);
  if (!actions.some((action) => JSON.stringify(action) === serialized)) actions.push(parsed.data);
  return ok('Action proposal accepted and will be sent to Slack for human confirmation.');
};

const parseChannelId = (value: string): string | null =>
  /<#(C[A-Z0-9]+)(?:\|[^>]*)?>/.exec(value)?.[1] ?? (/^C[A-Z0-9]+$/.test(value) ? value : null);

const requestContainsDollarAmount = (request: string, expectedCents: number): boolean => {
  const matches = request.matchAll(/\$?\s*(\d+(?:\.\d{1,2})?)/g);
  for (const match of matches) {
    const raw = match[1];
    if (raw !== undefined && Math.round(Number(raw) * 100) === expectedCents) return true;
  }
  return false;
};

const requestContainsNumber = (request: string, expected: number): boolean =>
  new RegExp(`(?:^|\\D)${expected}(?:\\D|$)`).test(request);

const requestContainsPhrase = (request: string, expected: string): boolean =>
  request.toLocaleLowerCase().includes(expected.toLocaleLowerCase());

const persistDoorDashDraft = async (
  args: RunAdminAgentArgs,
  sessionState: { artifact: AgentArtifact | null },
  slots: ArtifactSlots,
): Promise<void> => {
  if (!args.session) return;
  if (sessionState.artifact && sessionState.artifact.kind !== 'doordash_order') return;
  const artifact = await upsertOpenArtifact(args.db, {
    sessionId: args.session.id,
    workspaceId: args.workspace.id,
    kind: 'doordash_order',
    slots: { ...(sessionState.artifact?.slots ?? {}), ...slots },
  });
  sessionState.artifact = artifact;
};

const hydrateDoorDashDiscovery = async (
  args: RunAdminAgentArgs,
  discovery: DoorDashDiscoveryState,
  sessionState: { artifact: AgentArtifact | null },
): Promise<void> => {
  const artifact = sessionState.artifact;
  if (!args.doorDash || !artifact || artifact.kind !== 'doordash_order') return;
  const restaurant = artifact.slots.restaurant;
  const intent = buildDoorDashIntent(
    'Help the workspace admin continue a saved DoorDash draft',
    args.rawText,
  );
  let searchLat: number | null = null;
  let searchLng: number | null = null;
  if (typeof artifact.slots.deliveryAddress === 'string') {
    const resolved = await resolveSearchLocation(
      args.doorDash,
      artifact.slots.deliveryAddress,
      intent,
      args.geocodeAddress ?? geocodeUsAddress,
    );
    if (resolved.ok && resolved.value.kind === 'resolved') {
      discovery.deliveryAddress = resolved.value.location.printableAddress;
      discovery.placeId = resolved.value.location.placeId ?? null;
      discovery.addressId = resolved.value.location.addressId ?? null;
      searchLat = resolved.value.location.lat;
      searchLng = resolved.value.location.lng;
    } else {
      discovery.deliveryAddress = artifact.slots.deliveryAddress;
    }
  }
  let storeId = artifact.slots.storeId;
  if (!storeId && restaurant && searchLat !== null && searchLng !== null) {
    const found = await args.doorDash.searchRestaurants({
      query: restaurant,
      lat: searchLat,
      lng: searchLng,
      limit: 5,
      intent,
    });
    if (found.ok) {
      storeId = pickHydratedStoreId(found.value.stores, restaurant);
      for (const store of found.value.stores) {
        discovery.stores.set(store.store_id, { name: store.name });
      }
    }
  }
  if (!storeId) return;
  const storeName = discovery.stores.get(storeId)?.name ?? restaurant;
  if (!storeName) return;
  const menu = await args.doorDash.getMenu({ storeId, intent });
  if (!menu.ok) return;
  discovery.stores.set(storeId, { name: storeName });
  discovery.menus.set(storeId, menu.value);
  const items = matchDraftMenuItems(
    menu.value,
    artifact.kind === 'doordash_order' ? artifact.slots.items : undefined,
  );
  await persistDoorDashDraft(args, sessionState, {
    storeId,
    restaurant: storeName,
    menuId: menu.value.menu_id,
    ...(items.length > 0 ? { items } : {}),
    ...(discovery.deliveryAddress ? { deliveryAddress: discovery.deliveryAddress } : {}),
  });
};

const pickHydratedStoreId = (
  stores: Array<{ store_id: string; name: string }>,
  restaurant: string,
): string | undefined => {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/['’]/g, '');
  const wanted = normalize(restaurant);
  const exact = stores.find((store) => normalize(store.name) === wanted);
  if (exact) return exact.store_id;
  const named = stores.filter(
    (store) => normalize(store.name).includes(wanted) || wanted.includes(normalize(store.name)),
  );
  if (named.length === 1) return named[0]?.store_id;
  if (stores.length === 1) return stores[0]?.store_id;
  return undefined;
};

const matchDraftMenuItems = (
  menu: DoorDashMenu,
  draftItems: ArtifactSlots['items'],
): NonNullable<ArtifactSlots['items']> => {
  if (!draftItems) return [];
  return draftItems.flatMap((item) => {
    const found =
      menu.items.find((menuItem) => menuItem.item_id === item.itemId) ??
      menu.items.find(
        (menuItem) => menuItem.name.toLocaleLowerCase() === item.itemName.toLocaleLowerCase(),
      );
    if (!found) return [];
    return [
      {
        itemId: found.item_id,
        itemName: found.name,
        quantity: item.quantity,
        ...(item.nestedOptions ? { nestedOptions: item.nestedOptions } : {}),
      },
    ];
  });
};

const summarizeReloadedDoorDashDiscovery = (
  discovery: DoorDashDiscoveryState,
  artifact: AgentArtifact | null,
): string | null => {
  const entry = discovery.menus.entries().next().value;
  if (!entry) return null;
  const [storeId, menu] = entry;
  const store = discovery.stores.get(storeId);
  const items = matchDraftMenuItems(
    menu,
    artifact?.kind === 'doordash_order' ? artifact.slots.items : undefined,
  );
  return [
    'Reloaded DoorDash restaurant and menu from the active draft. Use these exact IDs. You may propose without searching again.',
    JSON.stringify({
      storeId,
      restaurant: store?.name,
      menuId: menu.menu_id,
      deliveryAddress: discovery.deliveryAddress,
      ...(items.length > 0 ? { items } : {}),
    }),
  ].join('\n');
};

const nestedOptionIdsWereDiscovered = (
  nestedOptions: Array<Record<string, unknown>> | undefined,
  discoveredIds: Set<string>,
): boolean => {
  if (!nestedOptions || nestedOptions.length === 0) return true;
  return selectedOptionIds(nestedOptions).every((id) => discoveredIds.has(id));
};

const loadItemDetails = async (
  doorDash: DdCliClient,
  discovery: DoorDashDiscoveryState,
  storeId: string,
  menuId: string,
  itemId: string,
  rawText: string,
): Promise<Result<{ ids: Set<string> } & ReturnType<typeof normalizeItemDetails>, string>> => {
  let raw = discovery.itemDetails.get(itemId);
  if (!raw) {
    const fetched = await doorDash.getItemDetails({
      storeId,
      menuId,
      itemId,
      intent: buildDoorDashIntent(
        'Help the workspace admin choose required DoorDash item options',
        rawText,
      ),
    });
    if (!fetched.ok) return err(doorDashToolError('DoorDash item details', fetched.error));
    raw = fetched.value;
    discovery.itemDetails.set(itemId, raw);
  }
  const details = normalizeItemDetails(raw);
  return ok({ ...details, ids: itemOptionIds(details) });
};

const resolveSearchLocation = async (
  doorDash: DdCliClient,
  requestedAddress: string | null,
  intent: string,
  geocodeAddress: typeof geocodeUsAddress,
): Promise<
  Result<
    | {
        kind: 'resolved';
        location: {
          printableAddress: string;
          lat: number;
          lng: number;
          source: 'saved' | 'found' | 'default';
          addressId?: string;
          placeId?: string;
        };
      }
    | { kind: 'ambiguous'; candidates: AddressCandidate[] },
    string
  >
> => {
  const listed = await doorDash.listAddresses(intent);
  if (!listed.ok) return err(doorDashToolError('DoorDash address lookup', listed.error));
  if (requestedAddress) {
    const saved = matchSavedAddress(listed.value.addresses, requestedAddress);
    if (saved) {
      const printable = savedAddressLabel(saved);
      if (!printable)
        return err(
          'A matching saved DoorDash address has no display value. Support code: DD-ADDRESS.',
        );
      return ok({
        kind: 'resolved',
        location: {
          printableAddress: printable,
          lat: saved.lat,
          lng: saved.lng,
          source: 'saved',
          addressId: savedAddressId(saved),
        },
      });
    }
    const found = await doorDash.findAddresses(requestedAddress, intent);
    if (!found.ok) return err(doorDashToolError('DoorDash address find', found.error));
    const picked = pickAddressCandidate(found.value.candidates, requestedAddress);
    if (!picked) {
      return ok({
        kind: 'ambiguous',
        candidates: found.value.candidates.slice(0, 5).map((candidate) => ({
          place_id: candidate.place_id,
          description: candidate.description,
        })),
      });
    }
    const geo = await geocodeAddress(picked.description);
    if (!geo.ok) {
      return err(
        'I found that address on DoorDash but could not get map coordinates yet. Ask the user to confirm the exact candidate, then retry. Support code: DD-ADDRESS.',
      );
    }
    return ok({
      kind: 'resolved',
      location: {
        printableAddress: picked.description,
        lat: geo.value.lat,
        lng: geo.value.lng,
        source: 'found',
        placeId: picked.place_id,
      },
    });
  }
  const defaultAddress = listed.value.addresses.find((address) => address.is_default);
  if (!defaultAddress) {
    return err(
      'No Slack delivery address was supplied and the DoorDash account has no default address. Ask the user for the street address. Support code: DD-ADDRESS.',
    );
  }
  const printable = savedAddressLabel(defaultAddress);
  if (!printable) {
    return err(
      'The DoorDash account default address has no usable display value. Ask the user for the street address. Support code: DD-ADDRESS.',
    );
  }
  return ok({
    kind: 'resolved',
    location: {
      printableAddress: printable,
      lat: defaultAddress.lat,
      lng: defaultAddress.lng,
      source: 'default',
    },
  });
};

const callWithTimeout = async (
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`admin agent timed out after ${ADMIN_AGENT_TIMEOUT_MS}ms`)),
      ADMIN_AGENT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([anthropic.messages.create(params), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};
