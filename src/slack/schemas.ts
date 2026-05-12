import { z } from 'zod';

// ─── slash command payload ──────────────────────────────────────────────────
// Slack POSTs application/x-www-form-urlencoded with these fields. We validate
// only the fields we actually consume; unknown fields are dropped by Zod.
export const slashCommandSchema = z.object({
  team_id: z.string().min(1),
  team_domain: z.string().min(1).optional(),
  user_id: z.string().min(1),
  user_name: z.string().min(1).optional(),
  command: z.string().min(1),
  text: z.string().default(''),
  response_url: z.string().url(),
  trigger_id: z.string().min(1),
});

export type SlashCommandPayload = z.infer<typeof slashCommandSchema>;

// ─── oauth callback query params ────────────────────────────────────────────
// On success Slack sends ?code=...&state=... ; on user denial ?error=access_denied&state=...
export const oauthCallbackSchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1),
    error: z.string().min(1).optional(),
  })
  .refine((v) => v.code !== undefined || v.error !== undefined, {
    message: 'oauth callback requires either code or error',
  });

export type OAuthCallbackParams = z.infer<typeof oauthCallbackSchema>;

// ─── oauth.v2.access response ───────────────────────────────────────────────
// The Slack API returns ok:true with the install payload, or ok:false with an error.
// We model this as a discriminated union on `ok`.
const oauthAccessSuccess = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  token_type: z.literal('bot'),
  scope: z.string(),
  bot_user_id: z.string().min(1),
  app_id: z.string().min(1),
  team: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  authed_user: z.object({
    id: z.string().min(1),
  }),
});

const oauthAccessFailure = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
});

export const oauthAccessSchema = z.discriminatedUnion('ok', [
  oauthAccessSuccess,
  oauthAccessFailure,
]);

export type OAuthAccessResponse = z.infer<typeof oauthAccessSchema>;
