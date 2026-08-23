import type { Db } from '@/db/client';
import { listOptedOut } from '@/db/queries/people';
import { isWorkspaceAdmin } from '@/db/queries/users';
import {
  getWorkspaceBySlackTeamId,
  setCelebrationChannel,
  setDefaultBudget,
} from '@/db/queries/workspaces';
import { log as defaultLog } from '@/lib/log';
import type { GetSlackClient } from '@/slack/client';
import {
  SUBCOMMAND_BUDGET,
  SUBCOMMAND_CHANNEL,
  SUBCOMMAND_HELLO,
  SUBCOMMAND_HELP,
  SUBCOMMAND_OPT_OUTS,
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
  '• Or ask in plain English, like `/confetti what is our budget?`';

const STATIC_SUBCOMMANDS = new Set([
  '',
  SUBCOMMAND_HELP,
  SUBCOMMAND_HELLO,
  SUBCOMMAND_CHANNEL,
  SUBCOMMAND_BUDGET,
  SUBCOMMAND_OPT_OUTS,
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

    default:
      return ephemeral(`Unknown subcommand: \`${subcommand}\`.\n\n${HELP_TEXT}`);
  }
};
