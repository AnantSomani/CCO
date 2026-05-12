// Populate process.env with valid dummy values BEFORE any test module loads,
// so that importing src/lib/env.ts (which validates eagerly) does not throw.
// Individual tests that exercise validation should call parseEnv() with crafted inputs.

process.env.DATABASE_URL =
  'postgresql://user:pass@localhost:6543/db?pgbouncer=true&connection_limit=1';
process.env.DIRECT_URL = 'postgresql://user:pass@localhost:5432/db';
process.env.SLACK_CLIENT_ID = 'test-client-id';
process.env.SLACK_CLIENT_SECRET = 'test-client-secret';
process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
process.env.SLACK_STATE_SECRET = 'test-state-secret';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.INNGEST_EVENT_KEY = 'test-inngest-event-key';
process.env.INNGEST_SIGNING_KEY = 'test-inngest-signing-key';
// 32 zero bytes, base64-encoded.
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
process.env.APP_BASE_URL = 'http://localhost:3000';
// NODE_ENV is typed read-only on NodeJS.ProcessEnv; assign via the wider record type.
(process.env as Record<string, string>).NODE_ENV = 'test';
