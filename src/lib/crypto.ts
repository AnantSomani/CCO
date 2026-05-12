import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const getKey = (): Buffer => Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');

export const encrypt = (plaintext: string): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
};

export const decrypt = (encoded: string): string => {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('Ciphertext too short');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
};
