import { type NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { log } from '@/lib/log';
import { getSlackClient } from '@/slack/client';
import { handleSlashCommand } from '@/slack/handlers/commands';
import { COMMAND_CONFETTI } from '@/slack/ids';
import { slashCommandSchema } from '@/slack/schemas';
import { verifySlackSignature } from '@/slack/signing';

export const dynamic = 'force-dynamic';

type SlackResponse = { response_type: 'ephemeral' | 'in_channel'; text: string };

const ephemeral = (text: string): NextResponse =>
  NextResponse.json<SlackResponse>({ response_type: 'ephemeral', text });

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const rawBody = await req.text();
  const sigResult = verifySlackSignature(rawBody, {
    'x-slack-signature': req.headers.get('x-slack-signature'),
    'x-slack-request-timestamp': req.headers.get('x-slack-request-timestamp'),
  });
  if (!sigResult.ok) {
    log.warn('slack signature verification failed', { reason: sigResult.error });
    return new NextResponse('signature verification failed', { status: 401 });
  }

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

  const reply = await handleSlashCommand({ db, getSlackClient }, payload);
  return NextResponse.json<SlackResponse>({ response_type: reply.responseType, text: reply.text });
};
