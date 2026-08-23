import { z } from 'zod';

const ENCRYPTION_KEY_BYTES = 32;

const isBase64ThirtyTwoBytes = (s: string): boolean => {
  const decoded = Buffer.from(s, 'base64');
  if (decoded.length !== ENCRYPTION_KEY_BYTES) return false;
  return decoded.toString('base64') === s;
};

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_STATE_SECRET: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),

  INNGEST_EVENT_KEY: z.string().min(1),
  INNGEST_SIGNING_KEY: z.string().min(1),

  TOKEN_ENCRYPTION_KEY: z.string().refine(isBase64ThirtyTwoBytes, {
    message:
      'TOKEN_ENCRYPTION_KEY must be base64 that decodes to exactly 32 bytes. Generate one with: openssl rand -base64 32',
  }),

  APP_BASE_URL: z.string().url(),
  DOORDASH_EXECUTOR: z.enum(['disabled', 'dd-cli']).default('disabled'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

export const parseEnv = (input: Record<string, string | undefined> = process.env): Env => {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
};

export const env: Env = parseEnv();
