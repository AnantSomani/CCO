import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';

// Implements Slack's request signing scheme:
// https://api.slack.com/authentication/verifying-requests-from-slack
// baseString = `v0:${timestamp}:${rawBody}`
// expectedSig = `v0=` + HMAC-SHA256(SLACK_SIGNING_SECRET, baseString) hex
// Compare timing-safe against the X-Slack-Signature header.

const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

type Headers = {
  'x-slack-signature'?: string | null;
  'x-slack-request-timestamp'?: string | null;
};

export const verifySlackSignature = (
  rawBody: string,
  headers: Headers,
  now: number = Math.floor(Date.now() / 1000),
): Result<void, string> => {
  const sigHeader = headers['x-slack-signature'];
  const tsHeader = headers['x-slack-request-timestamp'];

  if (!sigHeader || !tsHeader) return err('missing slack signing headers');

  const timestamp = Number(tsHeader);
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp)) {
    return err('invalid timestamp header');
  }
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return err('stale timestamp');
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expectedSig = `v0=${createHmac('sha256', env.SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex')}`;

  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const providedBuf = Buffer.from(sigHeader, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return err('signature mismatch');
  if (!timingSafeEqual(expectedBuf, providedBuf)) return err('signature mismatch');

  return ok(undefined);
};
