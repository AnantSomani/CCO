import type { Db } from '@/db/client';
import { getEventForApproval, updateEventStatus } from '@/db/queries/events';
import { getPostByEventId, insertPost } from '@/db/queries/posts';
import { getAdminUser } from '@/db/queries/workspaces';
import { log as defaultLog } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';
import { buildCelebrationPost, CARD_THREAD_PROMPT } from '@/slack/blocks/celebration-post';
import type { GetSlackClient } from '@/slack/client';
import { EVENT_NAME_DAY_OF_SCHEDULED } from '@/slack/ids';
import { inngest } from './client';

type Logger = {
  info: (m: string, meta?: Record<string, unknown>) => void;
  warn: (m: string, meta?: Record<string, unknown>) => void;
};

type RunArgs = {
  db: Db;
  getSlackClient: GetSlackClient;
  eventId: string;
  log?: Logger;
};

type GuardSkipReason = 'no_approval' | 'skipped' | 'already_posted' | 'no_celebration_channel';

type RunResult = { posted: true; postId: string } | { posted: false; reason: GuardSkipReason };

// Pure runner. Four idempotency guards (non-negotiable per ARCHITECTURE
// invariant #9):
//   1. no approval → return early
//   2. approval.decision === 'skipped' → return early
//   3. a posts row already exists for this event → return early
//   4. workspace has no celebration channel set → DM admin, return early
export const runDayOfPost = async ({
  db,
  getSlackClient,
  eventId,
  log = defaultLog,
}: RunArgs): Promise<Result<RunResult, string>> => {
  const bundle = await getEventForApproval(db, eventId);
  if (!bundle) return err(`event not found: ${eventId}`);

  const { event, person, workspace, suggestions, approval } = bundle;

  // Guard 1.
  if (!approval) {
    log.info('day-of skipped: no approval', { eventId });
    return ok({ posted: false, reason: 'no_approval' });
  }

  // Guard 2.
  if (approval.decision === 'skipped') {
    log.info('day-of skipped: approval was skip', { eventId });
    return ok({ posted: false, reason: 'skipped' });
  }

  // Guard 3.
  const existing = await getPostByEventId(db, eventId);
  if (existing) {
    log.info('day-of skipped: post already exists', { eventId, postId: existing.id });
    return ok({ posted: false, reason: 'already_posted' });
  }

  const slack = await getSlackClient(workspace.id);
  if (!slack.ok) return err(`slack client unavailable: ${slack.error}`);

  // Guard 4.
  if (!workspace.celebrationChannelId) {
    log.warn('day-of: no celebration channel set; DMing admin', { eventId });
    const admin = await getAdminUser(db, workspace.id);
    if (admin) {
      await slack.value.postMessage({
        channel: admin.slackUserId,
        text: 'Set a celebration channel via `/confetti channel` first — I have a celebration ready to post but nowhere to send it.',
      });
    }
    return ok({ posted: false, reason: 'no_celebration_channel' });
  }

  // Resolve the gesture: prefer the admin's modify text, then the chosen
  // suggestion, then the top-ranked suggestion.
  const chosen = suggestions.find((s) => s.id === approval.chosenSuggestionId) ?? suggestions[0];
  const built = buildCelebrationPost({
    person: { name: person.name, slackUserId: person.slackUserId },
    kind: event.kind,
    years: event.years,
    customGestureText: approval.customGestureText,
    suggestionSummary: chosen?.gestureSummary ?? null,
  });

  const top = await slack.value.postMessage({
    channel: workspace.celebrationChannelId,
    text: built.text,
    blocks: built.blocks,
  });
  if (!top.ok) return err(`postMessage (top) failed: ${top.error}`);

  const thread = await slack.value.postMessage({
    channel: workspace.celebrationChannelId,
    text: CARD_THREAD_PROMPT({ name: person.name }),
    thread_ts: top.value.ts,
  });
  if (!thread.ok) return err(`postMessage (thread) failed: ${thread.error}`);

  const post = await insertPost(db, {
    eventId,
    channelId: top.value.channel,
    slackTs: top.value.ts,
    threadTs: top.value.ts,
  });
  if (!post) {
    // Race with another invocation that beat us. Treat as already-posted.
    log.info('day-of: post inserted by concurrent run', { eventId });
    return ok({ posted: false, reason: 'already_posted' });
  }

  await updateEventStatus(db, eventId, 'posted');

  const admin = await getAdminUser(db, workspace.id);
  if (admin) {
    await slack.value.postMessage({
      channel: admin.slackUserId,
      text: `Posted for ${person.name}! Reply here with what you spent so I can log it (e.g. \`45\` for $45).`,
    });
  }

  log.info('day-of post complete', {
    eventId,
    workspaceId: workspace.id,
    channelId: top.value.channel,
    slackTs: top.value.ts,
    postId: post.id,
  });

  return ok({ posted: true, postId: post.id });
};

// Inngest wrapper. The `confetti/day-of.scheduled` event carries a future
// `ts` (set by the approve/modify handlers) — Inngest holds delivery until
// then, so the function body runs at the scheduled moment.
export const dayOfPost = inngest.createFunction(
  {
    id: 'day-of-post',
    triggers: [{ event: EVENT_NAME_DAY_OF_SCHEDULED }],
  },
  async ({ event }) => {
    const { db } = await import('@/db/client');
    const { getSlackClient } = await import('@/slack/client');
    const data = event.data as { eventId?: string };
    if (!data.eventId) return { ok: false, error: 'missing eventId' };
    const result = await runDayOfPost({
      db,
      getSlackClient,
      eventId: data.eventId,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, ...result.value };
  },
);
