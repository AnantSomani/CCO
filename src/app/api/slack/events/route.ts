import { type NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { inngest } from '@/jobs/client';
import { log } from '@/lib/log';
import { getSlackClient } from '@/slack/client';
import { handleMessageIm } from '@/slack/handlers/messages';
import { slackEventEnvelopeSchema } from '@/slack/schemas';
import { verifySlackSignature } from '@/slack/signing';

export const dynamic = 'force-dynamic';

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const rawBody = await req.text();

  // The url_verification challenge fires once during Slack app setup with NO
  // signature headers, so don't pre-verify; we'll only call verifySlackSignature
  // for non-challenge envelopes.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return new NextResponse('bad request', { status: 400 });
  }

  const parsed = slackEventEnvelopeSchema.safeParse(parsedJson);
  if (!parsed.success) {
    log.warn('events payload failed schema validation', {
      issues: parsed.error.issues.slice(0, 3),
    });
    return new NextResponse('', { status: 200 });
  }

  if (parsed.data.type === 'url_verification') {
    // Slack accepts plain-text challenge response or JSON {challenge}; plain
    // text is the documented minimum.
    return new NextResponse(parsed.data.challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // event_callback path — now we verify the signature.
  const sigResult = verifySlackSignature(rawBody, {
    'x-slack-signature': req.headers.get('x-slack-signature'),
    'x-slack-request-timestamp': req.headers.get('x-slack-request-timestamp'),
  });
  if (!sigResult.ok) {
    log.warn('events signature verification failed', { reason: sigResult.error });
    return new NextResponse('signature verification failed', { status: 401 });
  }

  const envelope = parsed.data;
  const inner = envelope.event;

  if (inner.type === 'app_uninstalled') {
    // v1: log only; full workspace cleanup is deferred (PROJECT.md week 4
    // task 7 — decide soft-mark vs hard-cascade then).
    log.info('app_uninstalled', { teamId: envelope.team_id });
    return new NextResponse('', { status: 200 });
  }

  if (inner.type === 'message') {
    const result = await handleMessageIm(
      { db, getSlackClient, emitter: inngest },
      envelope.team_id,
      {
        user: inner.user,
        text: inner.text,
        ts: inner.ts,
        bot_id: inner.bot_id,
        subtype: inner.subtype,
        thread_ts: inner.thread_ts,
      },
    );
    if (!result.ok) log.warn('message handler failed', { error: result.error });
    return new NextResponse('', { status: 200 });
  }

  return new NextResponse('', { status: 200 });
};
