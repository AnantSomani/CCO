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

// ─── interactivity payloads ─────────────────────────────────────────────────
// Slack POSTs application/x-www-form-urlencoded with a single `payload` field
// containing JSON. We validate the JSON, then route on `type`.
//
// Two payload types matter here:
//   - block_actions: a button tap. Contains user, team, channel, message, and
//     an `actions` array (we only care about [0] — buttons fire one at a time).
//   - view_submission: a modal submit. Contains user, team, and a `view`
//     object with `state.values` (Slack's nested dictionary of input values)
//     plus `private_metadata` carrying our routing info.

const blockActionsActionSchema = z.object({
  action_id: z.string().min(1),
  value: z.string().optional(),
});

const blockActionsMessageSchema = z.object({
  ts: z.string().min(1),
});

const blockActionsChannelSchema = z.object({
  id: z.string().min(1),
});

const blockActionsTeamSchema = z.object({
  id: z.string().min(1),
});

const blockActionsUserSchema = z.object({
  id: z.string().min(1),
});

export const blockActionsPayloadSchema = z.object({
  type: z.literal('block_actions'),
  team: blockActionsTeamSchema,
  user: blockActionsUserSchema,
  channel: blockActionsChannelSchema,
  message: blockActionsMessageSchema,
  trigger_id: z.string().min(1),
  actions: z.array(blockActionsActionSchema).min(1),
});

export type BlockActionsPayload = z.infer<typeof blockActionsPayloadSchema>;

// view.state.values is a 2-level dictionary: { block_id: { action_id: value } }
// where `value` shape depends on the input element. We model only what we need
// for the modify modal (plain_text_input + number_input).
const viewStateValueSchema = z.union([
  z.object({ type: z.literal('plain_text_input'), value: z.string().nullable() }),
  z.object({ type: z.literal('number_input'), value: z.string().nullable() }),
]);

export const viewSubmissionPayloadSchema = z.object({
  type: z.literal('view_submission'),
  team: blockActionsTeamSchema,
  user: blockActionsUserSchema,
  view: z.object({
    callback_id: z.string().min(1),
    private_metadata: z.string().default(''),
    state: z.object({
      values: z.record(z.string(), z.record(z.string(), viewStateValueSchema)),
    }),
  }),
});

export type ViewSubmissionPayload = z.infer<typeof viewSubmissionPayloadSchema>;

export const interactivityPayloadSchema = z.discriminatedUnion('type', [
  blockActionsPayloadSchema,
  viewSubmissionPayloadSchema,
]);

export type InteractivityPayload = z.infer<typeof interactivityPayloadSchema>;

// ─── events api ─────────────────────────────────────────────────────────────
// The events endpoint receives two top-level shapes: a one-time url_verification
// challenge, and the steady-state event_callback envelope.

const messageImEventSchema = z.object({
  type: z.literal('message'),
  channel_type: z.literal('im'),
  user: z.string().min(1).optional(),
  text: z.string().default(''),
  ts: z.string().min(1),
  // Set on bot messages — used to filter out our own posts so we don't loop.
  bot_id: z.string().min(1).optional(),
  subtype: z.string().optional(),
  // Present on thread replies; filter those out (we only want top-level DMs).
  thread_ts: z.string().optional(),
});

const appUninstalledEventSchema = z.object({
  type: z.literal('app_uninstalled'),
});

export const slackEventInnerSchema = z.discriminatedUnion('type', [
  messageImEventSchema,
  appUninstalledEventSchema,
]);

export type SlackInnerEvent = z.infer<typeof slackEventInnerSchema>;

export const urlVerificationSchema = z.object({
  type: z.literal('url_verification'),
  challenge: z.string().min(1),
});

export const eventCallbackSchema = z.object({
  type: z.literal('event_callback'),
  team_id: z.string().min(1),
  event: slackEventInnerSchema,
});

export const slackEventEnvelopeSchema = z.discriminatedUnion('type', [
  urlVerificationSchema,
  eventCallbackSchema,
]);

export type SlackEventEnvelope = z.infer<typeof slackEventEnvelopeSchema>;
