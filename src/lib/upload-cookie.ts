import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';

// HMAC-signed workspace cookie. Set by the OAuth callback after a successful
// install; read by the /upload page to gate access without re-doing OAuth.
// Same wire format as src/slack/state.ts; reuses SLACK_STATE_SECRET.

export const UPLOAD_COOKIE_NAME = 'confetti_ws';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const COOKIE_MAX_AGE_SECONDS = Math.floor(DEFAULT_MAX_AGE_MS / 1000);

type CookiePayload = { workspaceId: string; slackTeamId: string; ts: number };

const toBase64Url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = (s: string): Buffer => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (padded.length % 4)) % 4);
  return Buffer.from(padded + padding, 'base64');
};

const hmac = (payload: string): Buffer =>
  createHmac('sha256', env.SLACK_STATE_SECRET).update(payload).digest();

export const signUploadCookie = (
  workspaceId: string,
  slackTeamId: string,
  now: number = Date.now(),
): string => {
  const payload: CookiePayload = { workspaceId, slackTeamId, ts: now };
  const payloadJson = JSON.stringify(payload);
  const sig = hmac(payloadJson);
  return `${toBase64Url(Buffer.from(payloadJson, 'utf8'))}.${toBase64Url(sig)}`;
};

export const verifyUploadCookie = (
  token: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  now: number = Date.now(),
): Result<{ workspaceId: string; slackTeamId: string }, string> => {
  const parts = token.split('.');
  if (parts.length !== 2) return err('malformed cookie');
  const [payloadPart, sigPart] = parts as [string, string];

  let payloadJson: string;
  let providedSig: Buffer;
  try {
    payloadJson = fromBase64Url(payloadPart).toString('utf8');
    providedSig = fromBase64Url(sigPart);
  } catch {
    return err('cookie decode failed');
  }

  const expectedSig = hmac(payloadJson);
  if (providedSig.length !== expectedSig.length) return err('cookie signature mismatch');
  if (!timingSafeEqual(providedSig, expectedSig)) return err('cookie signature mismatch');

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return err('cookie payload not json');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { workspaceId?: unknown }).workspaceId !== 'string' ||
    typeof (parsed as { slackTeamId?: unknown }).slackTeamId !== 'string' ||
    typeof (parsed as { ts?: unknown }).ts !== 'number'
  ) {
    return err('cookie payload shape invalid');
  }
  const payload = parsed as CookiePayload;

  if (now - payload.ts > maxAgeMs) return err('cookie expired');
  if (payload.ts > now + 60_000) return err('cookie from the future');

  return ok({ workspaceId: payload.workspaceId, slackTeamId: payload.slackTeamId });
};
