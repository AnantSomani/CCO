import { type NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { inngest } from '@/jobs/client';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { getSlackClient } from '@/slack/client';
import { enqueueAgentCommand } from '@/slack/enqueue-agent-command';
import {
  getAgentAcknowledgement,
  handleSlashCommand,
  shouldRunCommandAgent,
} from '@/slack/handlers/commands';
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

  if (shouldRunCommandAgent(payload.text)) {
    let queued: Awaited<ReturnType<typeof enqueueAgentCommand>>;
    try {
      queued = await enqueueAgentCommand(db, inngest, {
        slackTeamId: payload.team_id,
        slackUserId: payload.user_id,
        requestText: payload.text,
        idempotencyKey: payload.trigger_id,
      });
    } catch (error) {
      log.error('admin agent enqueue threw', {
        slackTeamId: payload.team_id,
        userId: payload.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return ephemeral("I couldn't queue that request. Nothing was changed; please try again.");
    }
    if (!queued.ok) {
      log.error('failed to enqueue admin agent command', {
        slackTeamId: payload.team_id,
        userId: payload.user_id,
        error: queued.error,
      });
      return ephemeral("I couldn't queue that request. Nothing was changed; please try again.");
    }
    switch (queued.value.status) {
      case 'queued':
        return ephemeral(
          getAgentAcknowledgement(
            payload.text,
            env.DOORDASH_EXECUTOR === 'dd-cli' ? 'doordash' : 'sandbox',
          ),
        );
      case 'duplicate':
        return ephemeral("I'm already working on that request.");
      case 'unauthorized':
        return ephemeral('Only a Confetti workspace admin can use natural-language agent tools.');
      case 'rate_limited':
        return ephemeral('Too many agent requests at once. Please wait a minute and try again.');
      case 'unknown_workspace':
        return ephemeral("I don't recognize this workspace. Try reinstalling Confetti.");
    }
  }

  const reply = await handleSlashCommand({ db, getSlackClient }, payload);
  return NextResponse.json<SlackResponse>({ response_type: reply.responseType, text: reply.text });
};
