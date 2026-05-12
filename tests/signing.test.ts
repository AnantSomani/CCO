import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySlackSignature } from '@/slack/signing';

// The test setup sets SLACK_SIGNING_SECRET=test-signing-secret.
const SECRET = 'test-signing-secret';

const sign = (body: string, ts: number): string => {
  const base = `v0:${ts}:${body}`;
  return `v0=${createHmac('sha256', SECRET).update(base).digest('hex')}`;
};

describe('verifySlackSignature', () => {
  it('accepts a valid signature with a fresh timestamp', () => {
    const now = 1_700_000_000;
    const body = 'token=foo&team_id=T123';
    const result = verifySlackSignature(
      body,
      {
        'x-slack-signature': sign(body, now),
        'x-slack-request-timestamp': String(now),
      },
      now,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = 1_700_000_000;
    const body = 'token=foo&team_id=T123';
    const result = verifySlackSignature(
      'token=foo&team_id=Tdifferent',
      {
        'x-slack-signature': sign(body, now),
        'x-slack-request-timestamp': String(now),
      },
      now,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a stale timestamp (older than 5 minutes)', () => {
    const requestTs = 1_700_000_000;
    const now = requestTs + 301; // 5min + 1s
    const body = 'x=1';
    const result = verifySlackSignature(
      body,
      {
        'x-slack-signature': sign(body, requestTs),
        'x-slack-request-timestamp': String(requestTs),
      },
      now,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stale/);
  });

  it('rejects a timestamp far in the future', () => {
    const requestTs = 1_700_000_000;
    const now = requestTs - 301;
    const body = 'x=1';
    const result = verifySlackSignature(
      body,
      {
        'x-slack-signature': sign(body, requestTs),
        'x-slack-request-timestamp': String(requestTs),
      },
      now,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when signature header is missing', () => {
    const now = 1_700_000_000;
    const result = verifySlackSignature('x=1', { 'x-slack-request-timestamp': String(now) }, now);
    expect(result.ok).toBe(false);
  });

  it('rejects when timestamp header is missing', () => {
    const now = 1_700_000_000;
    const result = verifySlackSignature('x=1', { 'x-slack-signature': sign('x=1', now) }, now);
    expect(result.ok).toBe(false);
  });

  it('rejects when timestamp header is not numeric', () => {
    const now = 1_700_000_000;
    const result = verifySlackSignature(
      'x=1',
      { 'x-slack-signature': sign('x=1', now), 'x-slack-request-timestamp': 'banana' },
      now,
    );
    expect(result.ok).toBe(false);
  });
});
