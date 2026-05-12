import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/lib/crypto';

describe('crypto round-trip', () => {
  it('decrypts what it encrypts (ASCII)', () => {
    const plaintext = 'xoxb-1234567890-abcdefghij';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('decrypts what it encrypts (empty string)', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('decrypts what it encrypts (unicode)', () => {
    const plaintext = '🎉 confetti — birthday cake 🎂';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('decrypts what it encrypts (long string)', () => {
    const plaintext = 'a'.repeat(10_000);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('produces a different ciphertext on each call (random IV)', () => {
    const plaintext = 'same input';
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
  });
});

describe('crypto tamper detection', () => {
  it('throws when ciphertext bytes are flipped', () => {
    const ciphertext = encrypt('secret');
    const buf = Buffer.from(ciphertext, 'base64');
    // Flip a byte in the ciphertext region (after iv + authTag).
    const tamperedByte = buf[buf.length - 1] ?? 0;
    buf[buf.length - 1] = tamperedByte ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws when authTag bytes are flipped', () => {
    const ciphertext = encrypt('secret');
    const buf = Buffer.from(ciphertext, 'base64');
    // authTag occupies bytes 12..28.
    const tamperedByte = buf[20] ?? 0;
    buf[20] = tamperedByte ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws when ciphertext is too short', () => {
    expect(() => decrypt(Buffer.alloc(5).toString('base64'))).toThrow(/too short/);
  });
});
