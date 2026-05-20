import { type NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { inngest } from '@/jobs/client';
import { log } from '@/lib/log';
import { getSlackClient } from '@/slack/client';
import { handleApproveEvent, handleModifyEvent, handleSkipEvent } from '@/slack/handlers/actions';
import { handleModifySubmit } from '@/slack/handlers/views';
import {
  ACTION_APPROVE_EVENT,
  ACTION_MODIFY_EVENT,
  ACTION_SKIP_EVENT,
  CALLBACK_MODIFY_GESTURE,
} from '@/slack/ids';
import { interactivityPayloadSchema } from '@/slack/schemas';
import { verifySlackSignature } from '@/slack/signing';

export const dynamic = 'force-dynamic';

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const rawBody = await req.text();
  const sigResult = verifySlackSignature(rawBody, {
    'x-slack-signature': req.headers.get('x-slack-signature'),
    'x-slack-request-timestamp': req.headers.get('x-slack-request-timestamp'),
  });
  if (!sigResult.ok) {
    log.warn('interactivity signature verification failed', { reason: sigResult.error });
    return new NextResponse('signature verification failed', { status: 401 });
  }

  const fields = Object.fromEntries(new URLSearchParams(rawBody));
  const rawPayload = fields.payload;
  if (typeof rawPayload !== 'string' || !rawPayload) {
    log.warn('interactivity missing payload field');
    return new NextResponse('bad request', { status: 400 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawPayload);
  } catch {
    log.warn('interactivity payload JSON parse failed');
    return new NextResponse('bad request', { status: 400 });
  }

  const parsed = interactivityPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    log.warn('interactivity payload failed schema validation', {
      issues: parsed.error.issues.slice(0, 3),
    });
    return new NextResponse('bad request', { status: 400 });
  }

  const ctx = { db, getSlackClient, emitter: inngest };

  if (parsed.data.type === 'block_actions') {
    const actionId = parsed.data.actions[0]?.action_id;
    switch (actionId) {
      case ACTION_APPROVE_EVENT: {
        const result = await handleApproveEvent(ctx, parsed.data);
        if (!result.ok) log.warn('approve handler failed', { error: result.error });
        break;
      }
      case ACTION_SKIP_EVENT: {
        const result = await handleSkipEvent(ctx, parsed.data);
        if (!result.ok) log.warn('skip handler failed', { error: result.error });
        break;
      }
      case ACTION_MODIFY_EVENT: {
        const result = await handleModifyEvent(ctx, parsed.data);
        if (!result.ok) log.warn('modify handler failed', { error: result.error });
        break;
      }
      default:
        log.warn('unrouted action_id', { actionId });
    }
    return new NextResponse('', { status: 200 });
  }

  // view_submission
  if (parsed.data.view.callback_id !== CALLBACK_MODIFY_GESTURE) {
    log.warn('unrouted view callback_id', { callbackId: parsed.data.view.callback_id });
    return new NextResponse('', { status: 200 });
  }

  const result = await handleModifySubmit(ctx, parsed.data);
  if (!result.ok) {
    log.warn('modify submit failed', { error: result.error });
    return new NextResponse('', { status: 200 });
  }

  if (result.value.status === 'validation_error') {
    // Slack expects { response_action: 'errors', errors: { block_id: message } }
    // to keep the modal open with inline error rendering.
    return NextResponse.json({
      response_action: 'errors',
      errors: result.value.errors,
    });
  }

  return new NextResponse('', { status: 200 });
};
