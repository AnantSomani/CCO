import { describe, expect, it } from 'vitest';
import { signState, verifyState } from '@/slack/state';

describe('signState / verifyState', () => {
  it('round-trips: a freshly signed token verifies', () => {
    const token = signState();
    const result = verifyState(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.nonce).toBe('string');
      expect(result.value.nonce.length).toBeGreaterThan(0);
    }
  });

  it('produces a different token each time (random nonce)', () => {
    expect(signState()).not.toBe(signState());
  });

  it('rejects a malformed token (no dot)', () => {
    const result = verifyState('not-a-state-token');
    expect(result.ok).toBe(false);
  });

  it('rejects a token whose payload was tampered with', () => {
    const token = signState();
    const [payload, sig] = token.split('.') as [string, string];
    // Flip the last byte of the payload by changing one base64url char.
    const flipped = payload.slice(0, -1) + (payload.endsWith('A') ? 'B' : 'A');
    expect(verifyState(`${flipped}.${sig}`).ok).toBe(false);
  });

  it('rejects a token whose signature was tampered with', () => {
    const token = signState();
    const [payload, sig] = token.split('.') as [string, string];
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(verifyState(`${payload}.${flipped}`).ok).toBe(false);
  });

  it('rejects a token older than maxAgeMs', () => {
    const past = Date.now() - 11 * 60 * 1000; // 11 minutes ago, > 10min default
    const token = signState(past);
    const result = verifyState(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired/);
  });

  it('rejects a token from the future', () => {
    const future = Date.now() + 10 * 60 * 1000;
    const token = signState(future);
    const result = verifyState(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/future/);
  });

  it('still verifies a token if its sibling secret is unchanged', () => {
    // Two signs back-to-back should both still verify (no per-token state).
    const t1 = signState();
    const t2 = signState();
    expect(verifyState(t1).ok).toBe(true);
    expect(verifyState(t2).ok).toBe(true);
  });
});
