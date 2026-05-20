import { generateHardcodedSuggestions } from '@/agent/hardcoded';
import type { Db } from '@/db/client';
import { getEventForApproval, setEventApprovalMessage } from '@/db/queries/events';
import { insertSuggestions } from '@/db/queries/suggestions';
import { getAdminUser } from '@/db/queries/workspaces';
import { log as defaultLog } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';
import { buildApprovalDM } from '@/slack/blocks/approval-dm';
import type { GetSlackClient } from '@/slack/client';
import { EVENT_NAME_EVENT_CREATED } from '@/slack/ids';
import { inngest } from './client';

type Logger = { info: (m: string, meta?: Record<string, unknown>) => void };

type RunArgs = {
  db: Db;
  getSlackClient: GetSlackClient;
  eventId: string;
  log?: Logger;
};

type RunResult = {
  suggestionsCreated: number;
  approvalDmTs: string;
  approvalDmChannel: string;
};

// Pure runner — injected `getSlackClient` lets tests swap a recording stub.
// Loads the event, generates 2 hardcoded suggestions, persists them, sends
// the approval DM to the workspace's admin, then stashes the DM's channel + ts
// on the event row so action handlers can chat.update in place later.
export const runGenerateSuggestions = async ({
  db,
  getSlackClient,
  eventId,
  log = defaultLog,
}: RunArgs): Promise<Result<RunResult, string>> => {
  const bundle = await getEventForApproval(db, eventId);
  if (!bundle) return err(`event not found: ${eventId}`);

  const { event, person, workspace } = bundle;

  // Idempotency guard: if suggestions were already generated for this event,
  // re-running shouldn't double-DM. Cheapest check is the existing
  // suggestions count in the bundle.
  if (bundle.suggestions.length > 0) {
    log.info('generate-suggestions skipped — suggestions already exist', { eventId });
    return ok({
      suggestionsCreated: 0,
      approvalDmTs: event.approvalDmTs ?? '',
      approvalDmChannel: event.approvalDmChannelId ?? '',
    });
  }

  const admin = await getAdminUser(db, workspace.id);
  if (!admin) return err(`no admin user for workspace ${workspace.id}`);

  const inputs = generateHardcodedSuggestions({
    event: { kind: event.kind, years: event.years },
    person: { name: person.name },
    workspace: { id: workspace.id, defaultBudgetCents: workspace.defaultBudgetCents },
  });
  const created = await insertSuggestions(db, eventId, inputs);

  const slack = await getSlackClient(workspace.id);
  if (!slack.ok) return err(`slack client unavailable: ${slack.error}`);

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
  });

  return ok({
    suggestionsCreated: created.length,
    approvalDmTs: sent.value.ts,
    approvalDmChannel: sent.value.channel,
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
