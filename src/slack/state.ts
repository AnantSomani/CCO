import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';

// OAuth state param: a base64url-encoded JSON payload joined with an HMAC of
// that payload. Unforgeable (no secret = no valid HMAC) and stateless
// (no server-side store; expiry comes from the embedded timestamp).
//
// Format: `${base64url(payload)}.${base64url(hmac)}`
// Payload: { nonce: string, ts: number }

const NONCE_BYTES = 16;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

type StatePayload = { nonce: string; ts: number };

const toBase64Url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = (s: string): Buffer => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (padded.length % 4)) % 4);
  return Buffer.from(padded + padding, 'base64');
};

const hmac = (payload: string): Buffer =>
  createHmac('sha256', env.SLACK_STATE_SECRET).update(payload).digest();

export const signState = (now: number = Date.now()): string => {
  const payload: StatePayload = {
    nonce: randomBytes(NONCE_BYTES).toString('hex'),
    ts: now,
  };
  const payloadJson = JSON.stringify(payload);
  const sig = hmac(payloadJson);
  return `${toBase64Url(Buffer.from(payloadJson, 'utf8'))}.${toBase64Url(sig)}`;
};

export const verifyState = (
  token: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  now: number = Date.now(),
): Result<StatePayload, string> => {
  const parts = token.split('.');
  if (parts.length !== 2) return err('malformed state token');
  const [payloadPart, sigPart] = parts as [string, string];

  let payloadJson: string;
  let providedSig: Buffer;
  try {
    payloadJson = fromBase64Url(payloadPart).toString('utf8');
    providedSig = fromBase64Url(sigPart);
  } catch {
    return err('state token decode failed');
  }

  const expectedSig = hmac(payloadJson);
  if (providedSig.length !== expectedSig.length) return err('state signature mismatch');
  if (!timingSafeEqual(providedSig, expectedSig)) return err('state signature mismatch');

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return err('state payload not json');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { nonce?: unknown }).nonce !== 'string' ||
    typeof (parsed as { ts?: unknown }).ts !== 'number'
  ) {
    return err('state payload shape invalid');
  }
  const payload = parsed as StatePayload;

  if (now - payload.ts > maxAgeMs) return err('state expired');
  if (payload.ts > now + 60_000) return err('state from the future');

  return ok(payload);
};
