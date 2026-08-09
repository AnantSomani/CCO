import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { listOptedOut, listPeople } from '@/db/queries/people';
import type { Workspace } from '@/db/queries/workspaces';
import { err, ok, type Result } from '@/lib/result';
import {
  type ProposedAgentAction,
  proposedAgentActionSchema,
  sandboxEventPlanPayloadSchema,
  sandboxFoodOrderPayloadSchema,
} from './command-types';
import { AGENT_MAX_TOKENS, AGENT_MODEL, AGENT_TIMEOUT_MS } from './model';

const MAX_ROUNDS = 5;
const MAX_ACTIONS = 3;
const MAX_RESPONSE_CHARS = 700;

const TOOL_GET_WORKSPACE_SETTINGS = 'get_workspace_settings' as const;
const TOOL_LIST_OPTED_OUT = 'list_opted_out_people' as const;
const TOOL_LIST_ROSTER_SUMMARY = 'list_roster_summary' as const;
const TOOL_PROPOSE_SET_BUDGET = 'propose_set_default_budget' as const;
const TOOL_PROPOSE_SET_CHANNEL = 'propose_set_celebration_channel' as const;
const TOOL_PROPOSE_FOOD_ORDER = 'propose_sandbox_food_order' as const;
const TOOL_PROPOSE_EVENT_PLAN = 'propose_sandbox_event_plan' as const;
const TOOL_FINALIZE = 'finalize_response' as const;

const SYSTEM_PROMPT = `You are Confetti's admin copilot inside Slack. Help an authorized workspace admin understand roster state, configure Confetti, and plan team moments.

# Safety model
- Read-only tools execute immediately.
- Every mutation is only a proposal. A human must approve it in Slack before execution.
- Food orders and event plans are SANDBOX simulations. They never contact vendors, reserve anything, or spend money.
- Never claim an action completed. Say that it was prepared and requires approval.
- Never invent a channel, dollar amount, address, date, headcount, or vendor. Ask for missing details.
- The workspace budget is the maximum TOTAL cost for one event or action. It is never a per-person amount and must not be multiplied by headcount.
- Never expose birthdays, start dates, email addresses, or other personal roster data.

# How to work
- Use context tools when they materially help.
- Use a proposal tool only when the user explicitly asks for that action and provides every required field.
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

export type RunAdminAgentArgs = {
  anthropic: Anthropic;
  db: Db;
  workspace: Workspace;
  rawText: string;
  userId: string;
  log: Logger;
};

export type AdminAgentResult = {
  replyText: string;
  proposedActions: ProposedAgentAction[];
  toolCalls: AdminAgentToolCall[];
  model: string;
  rounds: number;
};

export type RunAdminAgent = (args: RunAdminAgentArgs) => Promise<Result<AdminAgentResult, string>>;

export const runAdminAgent: RunAdminAgent = async (args) => {
  const conversation: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        `Workspace: ${args.workspace.slackTeamName}`,
        `Workspace timezone: ${args.workspace.timezone}`,
        `Workspace total per-event budget cents: ${args.workspace.defaultBudgetCents}`,
        `Requesting Slack user: ${args.userId}`,
        `Request: ${args.rawText.trim()}`,
      ].join('\n'),
    },
  ];
  const proposedActions: ProposedAgentAction[] = [];
  const toolCalls: AdminAgentToolCall[] = [];

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
      const result = await runTool(args, toolUse, proposedActions);
      if (toolUse.name === TOOL_FINALIZE && result.ok) finalReply = result.value;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.ok ? result.value : result.error,
        ...(result.ok ? {} : { is_error: true }),
      });
    }

    if (finalReply) {
      return ok({
        replyText: finalReply,
        proposedActions,
        toolCalls,
        model: AGENT_MODEL,
        rounds: round,
      });
    }

    conversation.push({ role: 'user', content: toolResults });
  }

  return err('admin agent exceeded max rounds without finalizing');
};

const runTool = async (
  args: RunAdminAgentArgs,
  toolUse: Anthropic.ToolUseBlock,
  proposedActions: ProposedAgentAction[],
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
      if (!requestContainsDollarAmount(args.rawText, amountCents)) {
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
        !requestContainsPhrase(args.rawText, parsed.data.restaurant) ||
        !requestContainsPhrase(args.rawText, parsed.data.deliveryAddress) ||
        !requestContainsNumber(args.rawText, parsed.data.headcount) ||
        !requestContainsDollarAmount(args.rawText, parsed.data.estimatedCostCents)
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

    case TOOL_PROPOSE_EVENT_PLAN: {
      const parsed = proposeEventPlanInputSchema.safeParse(toolUse.input);
      if (!parsed.success) return err('event-plan proposal is missing required details');
      if (parsed.data.estimatedCostCents > args.workspace.defaultBudgetCents) {
        return err('event-plan estimate exceeds the workspace budget');
      }
      if (
        !requestContainsPhrase(args.rawText, parsed.data.title) ||
        !requestContainsPhrase(args.rawText, parsed.data.location) ||
        !requestContainsNumber(args.rawText, parsed.data.headcount) ||
        !requestContainsDollarAmount(args.rawText, parsed.data.estimatedCostCents)
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

    case TOOL_FINALIZE: {
      const parsed = finalizeResponseInputSchema.safeParse(toolUse.input);
      return parsed.success ? ok(parsed.data.reply_text) : err('invalid final response');
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

const callWithTimeout = async (
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`admin agent timed out after ${AGENT_TIMEOUT_MS}ms`)),
      AGENT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([anthropic.messages.create(params), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};
