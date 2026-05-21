import {
  getAnthropicClient as defaultGetAnthropicClient,
  type GetAnthropicClient,
} from '@/agent/anthropic-client';
import { runAgent as defaultRunAgent, type RunAgentArgs } from '@/agent/index';
import { appendAgentRunLog } from '@/agent/logging';
import type { Db } from '@/db/client';
import { listRecentApprovedGestures } from '@/db/queries/approvals';
import { getEventForApproval, setEventApprovalMessage } from '@/db/queries/events';
import { insertSuggestions } from '@/db/queries/suggestions';
import { getAdminUser } from '@/db/queries/workspaces';
import { log as defaultLog } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';
import { buildApprovalDM } from '@/slack/blocks/approval-dm';
import type { GetSlackClient } from '@/slack/client';
import { EVENT_NAME_EVENT_CREATED } from '@/slack/ids';
import { inngest } from './client';

type Logger = {
  info: (m: string, meta?: Record<string, unknown>) => void;
  warn: (m: string, meta?: Record<string, unknown>) => void;
  error: (m: string, meta?: Record<string, unknown>) => void;
};

type AgentRunner = (args: RunAgentArgs) => ReturnType<typeof defaultRunAgent>;

type RunArgs = {
  db: Db;
  getSlackClient: GetSlackClient;
  // Both are injected so tests can swap in a scripted Anthropic + stub
  // factory. Production wiring uses the real factory + real runAgent.
  getAnthropicClient?: GetAnthropicClient;
  runAgent?: AgentRunner;
  eventId: string;
  log?: Logger;
};

type RunResult = {
  suggestionsCreated: number;
  approvalDmTs: string;
  approvalDmChannel: string;
  usedFallback: boolean;
};

export const runGenerateSuggestions = async ({
  db,
  getSlackClient,
  getAnthropicClient = defaultGetAnthropicClient,
  runAgent = defaultRunAgent,
  eventId,
  log = defaultLog,
}: RunArgs): Promise<Result<RunResult, string>> => {
  const bundle = await getEventForApproval(db, eventId);
  if (!bundle) return err(`event not found: ${eventId}`);

  const { event, person, workspace } = bundle;

  // Idempotency guard: if suggestions were already generated for this event,
  // re-running shouldn't double-DM.
  if (bundle.suggestions.length > 0) {
    log.info('generate-suggestions skipped — suggestions already exist', { eventId });
    return ok({
      suggestionsCreated: 0,
      approvalDmTs: event.approvalDmTs ?? '',
      approvalDmChannel: event.approvalDmChannelId ?? '',
      usedFallback: false,
    });
  }

  const admin = await getAdminUser(db, workspace.id);
  if (!admin) return err(`no admin user for workspace ${workspace.id}`);

  // Closure for the recent-gestures tool — agent stays DB-agnostic; this
  // wiring layer is the only place that touches the DB on its behalf.
  const recentGesturesProvider = (limit: number) =>
    listRecentApprovedGestures(db, workspace.id, limit);

  const slack = await getSlackClient(workspace.id);
  if (!slack.ok) return err(`slack client unavailable: ${slack.error}`);

  const agentResult = await runAgent({
    anthropic: getAnthropicClient(),
    slackClient: slack.value,
    listRecentGestures: recentGesturesProvider,
    event: { kind: event.kind, years: event.years },
    person: {
      name: person.name,
      role: person.role,
      team: person.team,
      slackUserId: person.slackUserId,
      startDate: person.startDate,
    },
    workspace: {
      id: workspace.id,
      defaultBudgetCents: workspace.defaultBudgetCents,
      teamName: workspace.slackTeamName,
    },
    log,
  });

  if (!agentResult.ok) {
    log.error('agent precondition failure', { eventId, error: agentResult.error });
    return err(`agent: ${agentResult.error}`);
  }

  const created = await insertSuggestions(db, eventId, agentResult.suggestions);

  // JSONL log — fire-and-forget; never blocks suggestion generation.
  await appendAgentRunLog({
    ts: new Date().toISOString(),
    workspace_id: workspace.id,
    event_id: eventId,
    kind: event.kind,
    person_name: person.name,
    budget_cents: workspace.defaultBudgetCents,
    rounds: agentResult.rounds,
    tool_calls: agentResult.toolCalls,
    final_suggestions: created.map((s) => ({
      summary: s.gestureSummary,
      cost_cents: s.estimatedCostCents,
      rank: s.rank,
    })),
    used_fallback: agentResult.usedFallback,
    ...(agentResult.error ? { error: agentResult.error } : {}),
  });

  const dm = buildApprovalDM({
    event: { id: event.id, kind: event.kind, years: event.years },
    person: { name: person.name, role: person.role, team: person.team },
    suggestions: created.map((s) => ({
      id: s.id,
      gestureSummary: s.gestureSummary,
      estimatedCostCents: s.estimatedCostCents,
    })),
  });

  const sent = await slack.value.postMessage({
    channel: admin.slackUserId,
    text: dm.text,
    blocks: dm.blocks,
  });
  if (!sent.ok) return err(`postMessage failed: ${sent.error}`);

  await setEventApprovalMessage(db, eventId, sent.value.channel, sent.value.ts);

  log.info('approval DM sent', {
    eventId,
    workspaceId: workspace.id,
    adminSlackUserId: admin.slackUserId,
    suggestionsCreated: created.length,
    usedFallback: agentResult.usedFallback,
  });

  return ok({
    suggestionsCreated: created.length,
    approvalDmTs: sent.value.ts,
    approvalDmChannel: sent.value.channel,
    usedFallback: agentResult.usedFallback,
  });
};

// Inngest wrapper. Fires once per newly-created event from daily-scan.
export const generateSuggestions = inngest.createFunction(
  {
    id: 'generate-suggestions',
    triggers: [{ event: EVENT_NAME_EVENT_CREATED }],
  },
  async ({ event }) => {
    const { db } = await import('@/db/client');
    const { getSlackClient } = await import('@/slack/client');
    const data = event.data as { eventId?: string };
    if (!data.eventId) return { ok: false, error: 'missing eventId' };
    const result = await runGenerateSuggestions({
      db,
      getSlackClient,
      eventId: data.eventId,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, ...result.value };
  },
);
