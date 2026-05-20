import type { Db } from '@/db/client';
import { setOptedOutBySlackUser } from '@/db/queries/people';
import {
  findMostRecentUnloggedPostForWorkspace,
  getPostWithPerson,
  updatePostSpend,
} from '@/db/queries/posts';
import { getUserBySlackUserId } from '@/db/queries/users';
import { getWorkspaceBySlackTeamId } from '@/db/queries/workspaces';
import { log as defaultLog } from '@/lib/log';
import { ok, type Result } from '@/lib/result';
import type { GetSlackClient } from '@/slack/client';

type Logger = { info: (m: string, meta?: Record<string, unknown>) => void };

export type MessageHandlerCtx = {
  db: Db;
  getSlackClient: GetSlackClient;
  log?: Logger;
};

// Slack `message.im` event shape (inner). We only consume what we need.
export type MessageImEvent = {
  user?: string;
  text: string;
  ts: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
};

type ParsedMoney = { ok: true; cents: number } | { ok: false };

// Lenient on "45" and "$45.50"; rejects "forty-five" and free-form text. The
// number_input rule "first numeric token only" matched what the prompt asked
// for (`45`, `$45` → parse; `forty-five` → fail).
const parseMoney = (text: string): ParsedMoney => {
  const trimmed = text.trim();
  // Accept optional leading $, then digits and optional decimal.
  const match = trimmed.match(/^\$?(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return { ok: false };
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? '0').padEnd(2, '0'));
  if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return { ok: false };
  return { ok: true, cents: dollars * 100 + cents };
};

const OPT_OUT_RE = /^\s*skip my birthday!*\s*$/i;
const OPT_IN_RE = /^\s*include my birthday!*\s*$/i;

const HELP_TEXT =
  "I'm Confetti. I handle birthdays and work anniversaries.\nReply to a celebration with a dollar amount (e.g. `45`) to log spend, or DM `skip my birthday` to opt out.";

export type MessageHandlerOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'spend_logged'; cents: number }
  | { kind: 'spend_parse_error' }
  | { kind: 'opted_out'; personName: string }
  | { kind: 'opted_in'; personName: string }
  | { kind: 'opt_no_match' }
  | { kind: 'help' };

export const handleMessageIm = async (
  ctx: MessageHandlerCtx,
  teamId: string,
  event: MessageImEvent,
): Promise<Result<MessageHandlerOutcome, string>> => {
  const log = ctx.log ?? defaultLog;

  // Filter our own messages so we don't infinite-loop on DMs Confetti sends.
  if (event.bot_id || event.subtype === 'bot_message') {
    return ok({ kind: 'ignored', reason: 'bot_message' });
  }
  // Only handle top-level DMs.
  if (event.thread_ts) return ok({ kind: 'ignored', reason: 'thread_reply' });
  if (!event.user) return ok({ kind: 'ignored', reason: 'no_user' });

  const workspace = await getWorkspaceBySlackTeamId(ctx.db, teamId);
  if (!workspace) return ok({ kind: 'ignored', reason: 'unknown_workspace' });

  const slack = await ctx.getSlackClient(workspace.id);
  if (!slack.ok) return ok({ kind: 'ignored', reason: 'slack_client_unavailable' });

  const replyDm = async (text: string): Promise<void> => {
    if (!event.user) return;
    await slack.value.postMessage({ channel: event.user, text });
  };

  // ─── opt-out / opt-in (anyone, not just admin) ────────────────────────
  if (OPT_OUT_RE.test(event.text)) {
    const updated = await setOptedOutBySlackUser(ctx.db, workspace.id, event.user, true);
    if (!updated) {
      await replyDm(
        "I couldn't find you on the team roster — ask your admin to add your email + Slack id, then DM me again.",
      );
      return ok({ kind: 'opt_no_match' });
    }
    await replyDm("Got it — you're opted out. DM me `include my birthday` to reverse this.");
    log.info('person opted out', { workspaceId: workspace.id, personId: updated.personId });
    return ok({ kind: 'opted_out', personName: updated.name });
  }

  if (OPT_IN_RE.test(event.text)) {
    const updated = await setOptedOutBySlackUser(ctx.db, workspace.id, event.user, false);
    if (!updated) {
      await replyDm("I couldn't find you on the team roster — ask your admin to add you first.");
      return ok({ kind: 'opt_no_match' });
    }
    await replyDm("Back in — you're opted in.");
    log.info('person opted in', { workspaceId: workspace.id, personId: updated.personId });
    return ok({ kind: 'opted_in', personName: updated.name });
  }

  // ─── spend log (admin only) ──────────────────────────────────────────
  const user = await getUserBySlackUserId(ctx.db, workspace.id, event.user);
  if (user?.isAdmin) {
    const unlogged = await findMostRecentUnloggedPostForWorkspace(ctx.db, workspace.id);
    if (unlogged) {
      const parsed = parseMoney(event.text);
      if (parsed.ok) {
        await updatePostSpend(ctx.db, unlogged.id, parsed.cents);
        const enriched = await getPostWithPerson(ctx.db, unlogged.id);
        const dollars = parsed.cents / 100;
        const personName = enriched?.personName ?? 'them';
        await replyDm(
          `Logged $${dollars.toFixed(dollars % 1 === 0 ? 0 : 2)} for ${personName}. Thanks.`,
        );
        log.info('spend logged', {
          workspaceId: workspace.id,
          postId: unlogged.id,
          cents: parsed.cents,
        });
        return ok({ kind: 'spend_logged', cents: parsed.cents });
      }
      await replyDm("I couldn't parse that — try a number like `45`.");
      return ok({ kind: 'spend_parse_error' });
    }
  }

  await replyDm(HELP_TEXT);
  return ok({ kind: 'help' });
};
