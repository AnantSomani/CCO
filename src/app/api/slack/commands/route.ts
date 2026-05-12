import { type NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getWorkspaceBySlackTeamId } from '@/db/queries/workspaces';
import { log } from '@/lib/log';
import { COMMAND_CONFETTI, SUBCOMMAND_HELLO } from '@/slack/ids';
import { slashCommandSchema } from '@/slack/schemas';
import { verifySlackSignature } from '@/slack/signing';

export const dynamic = 'force-dynamic';

type SlackResponse = { response_type: 'ephemeral' | 'in_channel'; text: string };

const ephemeral = (text: string): NextResponse =>
  NextResponse.json<SlackResponse>({ response_type: 'ephemeral', text });

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  // 1. Read the raw body BEFORE parsing — signature is computed over raw bytes.
  const rawBody = await req.text();
  const sigResult = verifySlackSignature(rawBody, {
    'x-slack-signature': req.headers.get('x-slack-signature'),
    'x-slack-request-timestamp': req.headers.get('x-slack-request-timestamp'),
  });
  if (!sigResult.ok) {
    log.warn('slack signature verification failed', { reason: sigResult.error });
    return new NextResponse('signature verification failed', { status: 401 });
  }

  // 2. Parse the URL-encoded payload, validate with Zod.
  const fields = Object.fromEntries(new URLSearchParams(rawBody));
  const parseResult = slashCommandSchema.safeParse(fields);
  if (!parseResult.success) {
    log.warn('slash command payload failed schema validation', {
      issues: parseResult.error.issues,
    });
    return ephemeral('Sorry — that command payload looked wrong.');
  }
  const payload = parseResult.data;

  if (payload.command !== COMMAND_CONFETTI) {
    return ephemeral(`Unknown command: ${payload.command}`);
  }

  // 3. Dispatch on the first text token. The hello subcommand lives inline
  //    for v1; Session 3 will lift this into src/slack/handlers/commands.ts
  //    when there are real subcommands (setup, channel, budget, opt-outs).
  const subcommand = payload.text.trim().split(/\s+/)[0] ?? '';

  if (subcommand === SUBCOMMAND_HELLO) {
    const workspace = await getWorkspaceBySlackTeamId(db, payload.team_id);
    if (!workspace) {
      log.warn('slash command from unknown workspace', { slackTeamId: payload.team_id });
      return ephemeral("I don't recognize this workspace. Try reinstalling Confetti.");
    }
    return ephemeral(`Hi from Confetti — installed in ${workspace.slackTeamName}.`);
  }

  return ephemeral(
    `Hi! I'm Confetti. Try \`/confetti hello\` to confirm I'm here.\n(More commands land in Week 4: setup, channel, budget, opt-outs.)`,
  );
};
