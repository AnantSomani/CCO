// drizzle-kit is a CLI tool, not application code. To keep `pnpm db:*` commands
// usable before all runtime env vars (Slack, Anthropic, Inngest) are configured,
// this file reads DIRECT_URL directly from the env instead of going through
// src/lib/env.ts (which validates all 12 vars eagerly).
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

loadEnv({ path: '.env.local', override: true });

const directUrl = process.env.DIRECT_URL;
if (!directUrl || directUrl.trim() === '') {
  throw new Error(
    'DIRECT_URL is required for drizzle-kit. Set it in .env.local (Supabase direct connection, port 5432).',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: directUrl },
  strict: true,
  verbose: true,
});
