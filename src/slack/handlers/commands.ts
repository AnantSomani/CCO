import type { Db } from '@/db/client';
import { completeAgentAction, resumeAgentActionExecution } from '@/db/queries/agent-operations';
import {
  listRecoverableDoorDashExecutions,
  markDoorDashExecutionRecovered,
  reopenDoorDashExecution,
} from '@/db/queries/doordash-executions';
import { listOptedOut } from '@/db/queries/people';
import { isWorkspaceAdmin } from '@/db/queries/users';
import {
  getWorkspaceBySlackTeamId,
  setCelebrationChannel,
  setDefaultBudget,
} from '@/db/queries/workspaces';
import { createDdCliClient } from '@/integrations/doordash/dd-cli-client';
import { runAgentAction } from '@/jobs/execute-agent-action';
import { env } from '@/lib/env';
import { log as defaultLog } from '@/lib/log';
import type { GetSlackClient } from '@/slack/client';
import {
  SUBCOMMAND_BUDGET,
  SUBCOMMAND_CHANNEL,
  SUBCOMMAND_HELLO,
  SUBCOMMAND_HELP,
  SUBCOMMAND_OPT_OUTS,
  SUBCOMMAND_RECOVER,
} from '@/slack/ids';
import type { SlashCommandPayload } from '@/slack/schemas';

type Logger = {
  info: (m: string, meta?: Record<string, unknown>) => void;
  warn: (m: string, meta?: Record<string, unknown>) => void;
  error: (m: string, meta?: Record<string, unknown>) => void;
};

export type CommandHandlerCtx = {
  db: Db;
  getSlackClient: GetSlackClient;
  log?: Logger;
};

export type CommandReply = { responseType: 'ephemeral' | 'in_channel'; text: string };

const ephemeral = (text: string): CommandReply => ({ responseType: 'ephemeral', text });

const HELP_TEXT =
  "I'm Confetti — I run birthdays and work anniversaries.\n" +
  '• `/confetti channel <#channel>` — set the celebration channel\n' +
  '• `/confetti budget <usd>` — set the default per-event budget\n' +
  '• `/confetti opt-outs` — list opted-out teammates\n' +
  "• `/confetti hello` — check I'm alive\n" +
  '• `/confetti recover` — list or resume a DoorDash preview cart\n' +
  '• Or ask in plain English, like `/confetti what is our budget?`';

const STATIC_SUBCOMMANDS = new Set([
  '',
  SUBCOMMAND_HELP,
  SUBCOMMAND_HELLO,
  SUBCOMMAND_CHANNEL,
  SUBCOMMAND_BUDGET,
  SUBCOMMAND_OPT_OUTS,
  SUBCOMMAND_RECOVER,
]);

export const shouldRunCommandAgent = (text: string): boolean => {
  const subcommand = text.trim().split(/\s+/).filter(Boolean)[0] ?? '';
  return !STATIC_SUBCOMMANDS.has(subcommand);
};

export const getAgentAcknowledgement = (
  text: string,
  foodMode: 'sandbox' | 'doordash' = 'sandbox',
): string => {
  const request = text.trim().toLowerCase();
  if (/\b(food|lunch|meal|pizza|catering|restaurant|order)\b/.test(request)) {
    if (foodMode === 'doordash') {
      return "I'm checking live DoorDash options and the preview safety rules. I'll DM you the results or explain what needs adjusting; no order will be submitted.";
    }
    return "I'm checking the sandbox order against your budget and safety rules. I'll DM you the proposal or explain what needs adjusting.";
  }
  if (/\b(remind|reminder|nudge)\b/.test(request)) {
    return "I'm saving that reminder draft. I'll DM you what I have so far; scheduling it will require approval.";
  }
  if (/\b(event|venue|offsite|party|outing|retreat)\b/.test(request)) {
    return "I'm preparing the sandbox event plan. I'll DM you the proposal or explain what needs adjusting.";
  }
  if (/^(what|which|who|how many|show|list|summarize|check|tell me)\b/.test(request)) {
    return "I'm checking that now. I'll DM you the answer.";
  }
  return "I'm reviewing that request. I'll DM you the result; any change will require approval.";
};

// Slack sends `<#C0123|channel-name>` as the literal text for a channel
// mention; bare `C0123` also works. Both forms accepted.
const CHANNEL_MENTION_RE = /^<#(C[A-Z0-9]+)(?:\|[^>]*)?>$/;
const BARE_CHANNEL_ID_RE = /^(C[A-Z0-9]+)$/;

const parseChannelArg = (raw: string): string | null => {
  const trimmed = raw.trim();
  return CHANNEL_MENTION_RE.exec(trimmed)?.[1] ?? BARE_CHANNEL_ID_RE.exec(trimmed)?.[1] ?? null;
};

const parseBudgetArg = (raw: string): number | null => {
  const trimmed = raw.trim().replace(/^\$/, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
};

export const handleSlashCommand = async (
  ctx: CommandHandlerCtx,
  payload: SlashCommandPayload,
): Promise<CommandReply> => {
  const log = ctx.log ?? defaultLog;

  const workspace = await getWorkspaceBySlackTeamId(ctx.db, payload.team_id);
  if (!workspace) {
    log.info('slash command from unknown workspace', { slackTeamId: payload.team_id });
    return ephemeral("I don't recognize this workspace. Try reinstalling Confetti.");
  }

  const tokens = payload.text.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0] ?? '';
  const rest = tokens.slice(1).join(' ');

  if (subcommand !== '' && subcommand !== SUBCOMMAND_HELP && subcommand !== SUBCOMMAND_HELLO) {
    const isAdmin = await isWorkspaceAdmin(ctx.db, workspace.id, payload.user_id);
    if (!isAdmin)
      return ephemeral('Only a Confetti workspace admin can change or inspect settings.');
  }

  switch (subcommand) {
    case '':
    case SUBCOMMAND_HELP:
      return ephemeral(HELP_TEXT);

    case SUBCOMMAND_HELLO:
      return ephemeral(`Hi from Confetti — installed in ${workspace.slackTeamName}.`);

    case SUBCOMMAND_CHANNEL: {
      const channelId = parseChannelArg(rest);
      if (!channelId) {
        return ephemeral('Usage: `/confetti channel #your-channel`');
      }
      // Verify the bot can actually see the channel before saving — saves
      // the admin a confused day-of debug session if they forgot to invite us.
      const slack = await ctx.getSlackClient(workspace.id);
      if (!slack.ok) {
        return ephemeral("Couldn't reach Slack — try again in a sec.");
      }
      const info = await slack.value.conversationsInfo(channelId);
      if (!info.ok) {
        return ephemeral(
          `I couldn't see that channel (\`${info.error}\`). Invite me with \`/invite @Confetti\` and try again.`,
        );
      }
      if (!info.value.is_member) {
        return ephemeral(`I'm not in <#${channelId}> yet. Invite me with \`/invite @Confetti\`.`);
      }
      await setCelebrationChannel(ctx.db, workspace.id, channelId);
      log.info('celebration channel set', { workspaceId: workspace.id, channelId });
      return ephemeral(`Celebration channel set to <#${channelId}>. 🎉`);
    }

    case SUBCOMMAND_BUDGET: {
      const cents = parseBudgetArg(rest);
      if (cents === null) {
        return ephemeral('Usage: `/confetti budget 50` (USD, whole dollars or with cents)');
      }
      await setDefaultBudget(ctx.db, workspace.id, cents);
      log.info('default budget set', { workspaceId: workspace.id, cents });
      const dollars = cents / 100;
      return ephemeral(`Default budget set to $${dollars.toFixed(dollars % 1 === 0 ? 0 : 2)}.`);
    }

    case SUBCOMMAND_OPT_OUTS: {
      const rows = await listOptedOut(ctx.db, workspace.id);
      if (rows.length === 0) {
        return ephemeral('Nobody is opted out right now.');
      }
      const list = rows.map((r) => `• ${r.name} (${r.email})`).join('\n');
      return ephemeral(`Opted out (${rows.length}):\n${list}`);
    }

    case SUBCOMMAND_RECOVER:
      return recoverDoorDashPreview(ctx, workspace.id, rest);

    default:
      return ephemeral(`Unknown subcommand: \`${subcommand}\`.\n\n${HELP_TEXT}`);
  }
};

const ACTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const recoverDoorDashPreview = async (
  ctx: CommandHandlerCtx,
  workspaceId: string,
  rest: string,
): Promise<CommandReply> => {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    const rows = await listRecoverableDoorDashExecutions(ctx.db, workspaceId);
    if (rows.length === 0) {
      return ephemeral('There are no DoorDash preview carts waiting for recovery.');
    }
    const list = rows
      .map((row) => {
        const cart = row.cartUuid ? `cart \`${row.cartUuid}\`` : 'no cart yet';
        return `• \`${row.actionId}\` — ${row.status}, ${cart}${row.errorCode ? ` (${row.errorCode})` : ''}`;
      })
      .join('\n');
    return ephemeral(
      `Recoverable DoorDash previews:\n${list}\n\nRetry a quote with \`/confetti recover <action-id>\`.\nMark one handled with \`/confetti recover done <action-id>\`.`,
    );
  }
  if (tokens[0] === 'done' && tokens[1] && ACTION_ID_RE.test(tokens[1])) {
    const marked = await markDoorDashExecutionRecovered(ctx.db, tokens[1], workspaceId);
    if (!marked) return ephemeral('I could not find a recoverable preview for that action.');
    await completeAgentAction(ctx.db, tokens[1], {
      recovered: true,
      previewOnly: true,
      cartUuid: marked.cartUuid,
    });
    return ephemeral(
      marked.cartUuid
        ? `Marked preview \`${tokens[1]}\` recovered. Cart \`${marked.cartUuid}\` was not submitted.`
        : `Marked preview \`${tokens[1]}\` recovered. No cart was created. Nothing was submitted.`,
    );
  }
  const actionId = tokens[0];
  if (!actionId || !ACTION_ID_RE.test(actionId)) {
    return ephemeral('Usage: `/confetti recover` or `/confetti recover <action-id>`');
  }
  await reopenDoorDashExecution(ctx.db, actionId, workspaceId);
  const resumed = await resumeAgentActionExecution(ctx.db, actionId, workspaceId);
  if (!resumed) return ephemeral('That action is not waiting for DoorDash recovery.');
  const result = await runAgentAction({
    db: ctx.db,
    getSlackClient: ctx.getSlackClient,
    doorDash: env.DOORDASH_EXECUTOR === 'dd-cli' ? createDdCliClient() : undefined,
    actionId,
  });
  if (!result.ok) {
    return ephemeral(
      'I could not finish the retry. No order was submitted. Check `/confetti recover` again in a moment.',
    );
  }
  if (result.value.status === 'needs_review') {
    return ephemeral(
      'The live quote still needs review. No order was submitted. Use `/confetti recover` to inspect the cart.',
    );
  }
  return ephemeral(
    'Retried the saved cart and updated the approval message. No order was submitted.',
  );
};
