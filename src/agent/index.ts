import type Anthropic from '@anthropic-ai/sdk';
import { differenceInDays } from 'date-fns';
import { log as defaultLog } from '@/lib/log';
import type { SlackClient } from '@/slack/client';

import {
  AGENT_MAX_TOKENS,
  AGENT_MODEL,
  AGENT_TIMEOUT_MS,
  FORCE_TERMINAL_ROUND,
  MAX_ROUNDS,
} from './model';
import { SYSTEM_PROMPT } from './prompt';
import {
  ANTHROPIC_TOOLS,
  formatZodIssues,
  listRecentGesturesInputSchema,
  PROPOSE_SUGGESTIONS_TOOL,
  type ProposeSuggestionsInput,
  proposeSuggestionsInputSchema,
  TOOL_GET_PERSON_PROFILE,
  TOOL_LIST_RECENT_GESTURES,
  TOOL_PROPOSE_SUGGESTIONS,
  validateProposeBusinessRules,
} from './tools';
import type { AgentEvent, AgentPerson, AgentResult, AgentToolCall, AgentWorkspace } from './types';

type Logger = {
  info: (m: string, meta?: Record<string, unknown>) => void;
  warn: (m: string, meta?: Record<string, unknown>) => void;
  error: (m: string, meta?: Record<string, unknown>) => void;
};

export type RecentGestureRow = {
  summary: string;
  kind: 'birthday' | 'anniversary';
  cost_cents: number;
  decided_at: string;
};

export type ListRecentGestures = (limit: number) => Promise<RecentGestureRow[]>;

export type RunAgentArgs = {
  anthropic: Anthropic;
  // Optional — used by get_person_profile to enrich with Slack users.info. If
  // absent (or the call fails), the tool returns DB-only data and warns. Per
  // spec: a flaky Slack must not break suggestion generation.
  slackClient?: SlackClient;
  // Optional provider for recent approved gestures. In production the wiring
  // layer in generate-suggestions.ts closes over the DB + workspace.id and
  // passes a real implementation; tests pass a stub. If absent, the tool
  // returns an empty list.
  listRecentGestures?: ListRecentGestures;
  event: AgentEvent;
  person: AgentPerson;
  workspace: AgentWorkspace;
  log?: Logger;
};

// The tool-use loop. Hard cap of 5 rounds; on the final round the request only
// carries propose_suggestions and tool_choice forces it. Validates
// propose_suggestions in two passes (Zod, then business rules), allows one
// retry, then falls back to a safe single-suggestion result. Every exit path
// returns ≥ 1 suggestion (or ok:false for true precondition failures).
export const runAgent = async (args: RunAgentArgs): Promise<AgentResult> => {
  const log = args.log ?? defaultLog;
  const budget = args.workspace.defaultBudgetCents;

  if (budget <= 0) {
    return { ok: false, error: `workspace budget is non-positive: ${budget}` };
  }

  const userMessage = buildUserMessage(args.event, args.person, args.workspace);
  const conversation: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];
  const toolCalls: AgentToolCall[] = [];

  let validationRetryUsed = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const forceTerminal = round >= FORCE_TERMINAL_ROUND;
    const tools = forceTerminal ? [PROPOSE_SUGGESTIONS_TOOL] : ANTHROPIC_TOOLS;
    const tool_choice: Anthropic.ToolChoice = forceTerminal
      ? { type: 'tool', name: TOOL_PROPOSE_SUGGESTIONS }
      : { type: 'auto' };

    let response: Anthropic.Message;
    try {
      response = await callWithTimeout(args.anthropic, {
        model: AGENT_MODEL,
        max_tokens: AGENT_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools,
        tool_choice,
        messages: conversation,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('agent api call failed', {
        round,
        workspaceId: args.workspace.id,
        error: msg,
      });
      return buildFallback(args, round, toolCalls, `api_error: ${msg}`);
    }

    // Mirror the assistant turn into the conversation so tool_use_id refs line
    // up on the next round. Response blocks are structurally compatible with
    // the param block subset we use (text + tool_use); the cast is safe.
    conversation.push({
      role: 'assistant',
      content: response.content as unknown as Anthropic.ContentBlockParam[],
    });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      log.warn('agent produced no tool call this round', {
        round,
        workspaceId: args.workspace.id,
        stopReason: response.stop_reason,
      });
      if (round === MAX_ROUNDS) {
        return buildFallback(args, round, toolCalls, 'no_tool_call_after_max_rounds');
      }
      conversation.push({
        role: 'user',
        content:
          'Please use the tools — either fetch more context, or call propose_suggestions to commit your final output.',
      });
      continue;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let validatedTerminal: ProposeSuggestionsInput | null = null;
    let validationErrorThisRound: string | null = null;

    for (const block of toolUses) {
      toolCalls.push({ name: block.name, input: block.input as Record<string, unknown> });

      if (block.name === TOOL_PROPOSE_SUGGESTIONS) {
        // Defensive unwrap: the model occasionally double-encodes
        // `suggestions` as a JSON string instead of a JSON array. Quality
        // content underneath; just the wrong wire format. Salvage it before
        // Zod would reject. Observed during CP3 tuning.
        const rawInput = block.input as Record<string, unknown>;
        const candidate =
          typeof rawInput?.suggestions === 'string'
            ? (() => {
                try {
                  return { ...rawInput, suggestions: JSON.parse(rawInput.suggestions as string) };
                } catch {
                  return rawInput;
                }
              })()
            : rawInput;
        const parsed = proposeSuggestionsInputSchema.safeParse(candidate);
        if (!parsed.success) {
          const msg = `Invalid propose_suggestions input: ${formatZodIssues(parsed.error)}`;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `${msg}. Please call propose_suggestions again with corrected suggestions.`,
            is_error: true,
          });
          validationErrorThisRound = msg;
          continue;
        }
        const businessErrors = validateProposeBusinessRules(parsed.data, budget);
        if (businessErrors.length > 0) {
          const msg = businessErrors.map((e) => `${e.field}: ${e.message}`).join('; ');
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Validation failed — ${msg}. Please call propose_suggestions again with corrected suggestions.`,
            is_error: true,
          });
          validationErrorThisRound = msg;
          continue;
        }
        validatedTerminal = parsed.data;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Suggestions accepted.',
        });
      } else if (block.name === TOOL_GET_PERSON_PROFILE) {
        const profile = await runGetPersonProfile(args, log);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(profile),
        });
      } else if (block.name === TOOL_LIST_RECENT_GESTURES) {
        const parsed = listRecentGesturesInputSchema.safeParse(block.input);
        const limit = parsed.success && parsed.data.limit !== undefined ? parsed.data.limit : 10;
        const rows = args.listRecentGestures ? await args.listRecentGestures(limit) : [];
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ recent: rows }),
        });
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Unknown tool: ${block.name}`,
          is_error: true,
        });
      }
    }

    if (validatedTerminal) {
      return {
        ok: true,
        suggestions: validatedTerminal.suggestions.map((s, i) => ({
          gestureSummary: s.summary,
          gestureDetails: {
            source: 'agent',
            kind: args.event.kind,
            rank: i + 1,
            rationale: s.rationale,
            details: s.details,
          },
          estimatedCostCents: s.estimated_cost_cents,
          rank: i + 1,
        })),
        usedFallback: false,
        rounds: round,
        toolCalls,
      };
    }

    // Append the batch of tool results so the next round can see them.
    conversation.push({ role: 'user', content: toolResults });

    if (validationErrorThisRound) {
      if (validationRetryUsed) {
        return buildFallback(
          args,
          round,
          toolCalls,
          `validation_failed_after_retry: ${validationErrorThisRound}`,
        );
      }
      validationRetryUsed = true;
    }
  }

  return buildFallback(args, MAX_ROUNDS, toolCalls, 'max_rounds_exceeded_no_terminal_call');
};

// ─── prompt construction ─────────────────────────────────────────────────────

const buildUserMessage = (
  event: AgentEvent,
  person: AgentPerson,
  workspace: AgentWorkspace,
): string => {
  const lines: string[] = [];
  if (event.kind === 'birthday') {
    lines.push('Event: birthday');
  } else {
    const yrs = event.years ?? 1;
    lines.push(`Event: ${yrs}-year work anniversary`);
  }
  lines.push(`Person: ${person.name}`);
  if (person.role) lines.push(`Role: ${person.role}`);
  if (person.team) lines.push(`Team: ${person.team}`);
  if (person.slackUserId) lines.push(`Slack: <@${person.slackUserId}>`);
  lines.push(
    `Budget: up to ${formatUsd(workspace.defaultBudgetCents)} (${workspace.defaultBudgetCents} cents)`,
  );
  lines.push(`Workspace: ${workspace.teamName}`);
  lines.push('');
  lines.push(
    'Propose 2 or 3 suggestions via the propose_suggestions tool. Use the context tools first if you need more information about this person or recent gestures.',
  );
  return lines.join('\n');
};

const formatUsd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// ─── fallback ────────────────────────────────────────────────────────────────
// Single safe suggestion. Returns ok:true so callers still get something to
// DM the admin — the alternative is silently dropping a birthday, which the
// product cannot do. `usedFallback: true` + `error` capture the reason so the
// JSONL log records what went wrong.

const buildFallback = (
  args: RunAgentArgs,
  rounds: number,
  toolCalls: AgentToolCall[],
  reason: string,
): AgentResult => {
  const budget = args.workspace.defaultBudgetCents;
  const log = args.log ?? defaultLog;
  log.error('agent fell back to safe suggestion', {
    workspaceId: args.workspace.id,
    kind: args.event.kind,
    rounds,
    reason,
  });
  return {
    ok: true,
    suggestions: [
      {
        gestureSummary: 'Card from the team',
        gestureDetails: {
          source: 'fallback',
          kind: args.event.kind,
          rank: 1,
          rationale: 'Reliable, kind, always appropriate.',
          details: 'A team-signed card delivered on the day.',
          fallback_reason: reason,
        },
        estimatedCostCents: Math.min(3000, budget),
        rank: 1,
      },
    ],
    usedFallback: true,
    rounds,
    toolCalls,
    error: reason,
  };
};

// ─── context tool handlers ───────────────────────────────────────────────────

type PersonProfileResult = {
  name: string;
  role: string | null;
  team: string | null;
  tenure_days: number | null;
  slack_user_id: string | null;
  // Populated when the optional Slack call succeeds. Absent on DB-only paths.
  slack_title?: string;
  slack_pronouns?: string;
};

const computeTenureDays = (startDate: string | null): number | null => {
  if (!startDate) return null;
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  return Math.max(0, differenceInDays(new Date(), start));
};

const runGetPersonProfile = async (
  args: RunAgentArgs,
  log: Logger,
): Promise<PersonProfileResult> => {
  const base: PersonProfileResult = {
    name: args.person.name,
    role: args.person.role,
    team: args.person.team,
    tenure_days: computeTenureDays(args.person.startDate),
    slack_user_id: args.person.slackUserId,
  };
  if (!args.slackClient || !args.person.slackUserId) {
    return base;
  }
  // Graceful degradation: if the Slack call fails (rate limit, network, scope
  // gap), return DB-only data and warn. Do not break suggestion generation.
  const result = await args.slackClient.usersInfo(args.person.slackUserId);
  if (!result.ok) {
    log.warn('users.info failed; returning DB-only person profile', {
      workspaceId: args.workspace.id,
      error: result.error,
    });
    return base;
  }
  return {
    ...base,
    ...(result.value.title ? { slack_title: result.value.title } : {}),
    ...(result.value.pronouns ? { slack_pronouns: result.value.pronouns } : {}),
  };
};

// ─── timeout wrapper ─────────────────────────────────────────────────────────

const callWithTimeout = async (
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    return await anthropic.messages.create(params, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};
