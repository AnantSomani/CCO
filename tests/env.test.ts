import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/lib/env';

const validBase: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:6543/db?pgbouncer=true&connection_limit=1',
  DIRECT_URL: 'postgresql://user:pass@localhost:5432/db',
  SLACK_CLIENT_ID: 'cid',
  SLACK_CLIENT_SECRET: 'csec',
  SLACK_SIGNING_SECRET: 'ssec',
  SLACK_STATE_SECRET: 'ssec2',
  ANTHROPIC_API_KEY: 'ak',
  INNGEST_EVENT_KEY: 'iek',
  INNGEST_SIGNING_KEY: 'isk',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  APP_BASE_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
};

describe('parseEnv', () => {
  it('parses a valid environment', () => {
    const env = parseEnv(validBase);
    expect(env.DATABASE_URL).toBe(validBase.DATABASE_URL);
    expect(env.NODE_ENV).toBe('test');
  });

  it('defaults NODE_ENV to development when omitted', () => {
    const { NODE_ENV: _omit, ...rest } = validBase;
    const env = parseEnv(rest);
    expect(env.NODE_ENV).toBe('development');
  });

  it('throws when a required field is missing', () => {
    const { SLACK_CLIENT_ID: _omit, ...rest } = validBase;
    expect(() => parseEnv(rest)).toThrow(/SLACK_CLIENT_ID/);
  });

  it('throws when DATABASE_URL is not a URL', () => {
    expect(() => parseEnv({ ...validBase, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('throws when TOKEN_ENCRYPTION_KEY decodes to fewer than 32 bytes', () => {
    expect(() =>
      parseEnv({ ...validBase, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('throws when TOKEN_ENCRYPTION_KEY decodes to more than 32 bytes', () => {
    expect(() =>
      parseEnv({ ...validBase, TOKEN_ENCRYPTION_KEY: Buffer.alloc(48).toString('base64') }),
    ).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('throws when TOKEN_ENCRYPTION_KEY is not valid base64', () => {
    expect(() => parseEnv({ ...validBase, TOKEN_ENCRYPTION_KEY: 'not-valid-base64-!!!' })).toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });
});
