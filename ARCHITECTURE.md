# ARCHITECTURE.md — Confetti v1

> The stack, repository layout, data model, agent loop, invariants, and locked decisions. Read in full at the start of every session along with `PROJECT.md` and `CONVENTIONS.md`.

---

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20+ | Slack Bolt, broad compatibility |
| Web framework | Next.js 15 (App Router) | OAuth callbacks, Slack endpoints, future dashboard |
| Language | TypeScript (strict) | Type safety pays for itself with AI-assisted code |
| Database | Supabase Postgres | Generous free tier, easy provisioning. Used *only* as Postgres in v1 — no Auth, Storage, Realtime, or JS client. |
| ORM | Drizzle | Type-safe, explicit, AI-friendly schema |
| Slack SDK | `@slack/bolt` | Official, handles signing + interactivity |
| LLM | Anthropic SDK (`@anthropic-ai/sdk`), Claude Sonnet | Tool use is mature and predictable |
| Background jobs | Inngest | Durable, retryable, great dev UI, cron + events |
| Hosting | Vercel | Zero-config Next.js, free for v1 |
| Validation | Zod | Schema-first input validation |
| Secrets | Vercel env vars + a single encryption key | Upgrade to KMS later |
| Testing | Vitest | Fast, ESM-native |
| Lint/format | Biome | Single tool, fast |
| Package manager | pnpm | Faster, stricter |

Pin major versions in `package.json`. Do not auto-upgrade.

## Repository layout

```
confetti/
├── PROJECT.md
├── ARCHITECTURE.md
├── CONVENTIONS.md
├── README.md
├── package.json
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── slack-manifest.yaml
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── slack/
│   │   │   │   ├── install/route.ts          # GET — start OAuth
│   │   │   │   ├── oauth_callback/route.ts   # GET — finish OAuth
│   │   │   │   ├── events/route.ts           # POST — Slack events
│   │   │   │   ├── interactivity/route.ts    # POST — buttons, modals
│   │   │   │   └── commands/route.ts         # POST — slash commands
│   │   │   └── inngest/route.ts              # Inngest webhook
│   │   ├── upload/page.tsx                   # CSV upload (Slack-auth gated)
│   │   └── page.tsx                          # Landing/install button
│   ├── db/
│   │   ├── schema.ts                         # Drizzle tables
│   │   ├── client.ts                         # db instance
│   │   └── queries/                          # all named queries live here
│   ├── slack/
│   │   ├── client.ts                         # Bolt receiver setup
│   │   ├── blocks/                           # Block Kit builders
│   │   │   ├── approval-dm.ts
│   │   │   ├── celebration-post.ts
│   │   │   └── modify-modal.ts
│   │   ├── handlers/
│   │   │   ├── commands.ts
│   │   │   ├── actions.ts                    # button taps
│   │   │   ├── views.ts                      # modal submissions
│   │   │   └── messages.ts                   # spend-reply parsing
│   │   └── tokens.ts                         # encrypt/decrypt
│   ├── agent/
│   │   ├── index.ts                          # main agent entry
│   │   ├── prompt.ts                         # system prompt
│   │   ├── tools.ts                          # tool definitions + handlers
│   │   └── types.ts                          # Suggestion, Context, etc.
│   ├── jobs/
│   │   ├── client.ts                         # Inngest client
│   │   ├── daily-scan.ts                     # cron
│   │   ├── generate-suggestions.ts           # event-triggered
│   │   └── day-of-post.ts                    # scheduled per event
│   ├── lib/
│   │   ├── dates.ts                          # timezone-aware date math
│   │   ├── csv.ts                            # parse + validate CSV
│   │   ├── crypto.ts                         # token encryption
│   │   ├── result.ts                         # Result<T, E> type
│   │   ├── log.ts                            # console wrapper
│   │   └── env.ts                            # validated env access
│   └── types/
│       └── slack.ts                          # shared Slack types
├── drizzle/                                  # generated migrations
└── tests/
    ├── dates.test.ts
    ├── csv.test.ts
    ├── agent-tools.test.ts
    └── handlers.test.ts
```

Do not deviate from this structure without updating this document in the same commit. Files only exist when they are used now, not "for later."

## Data model

Seven tables. Implemented in Drizzle at `src/db/schema.ts`.

### workspaces

```
id                       uuid pk default gen_random_uuid()
slack_team_id            text not null unique         -- natural key for OAuth upserts
slack_team_name          text not null                -- cached at install; refreshed on reinstall
bot_access_token_enc     text not null                -- encrypted
installed_by_slack_user  text not null
celebration_channel_id   text                         -- nullable until set
default_budget_cents     integer not null default 5000
timezone                 text not null default 'America/New_York'
created_at               timestamptz not null default now()
updated_at               timestamptz not null default now()
```

### users

Admins who can approve. v1 has one admin per workspace (the installer), but the table supports more.

```
id              uuid pk
workspace_id    uuid fk → workspaces.id, on delete cascade
slack_user_id   text not null
email           text
name            text
is_admin        boolean not null default true
created_at      timestamptz not null default now()
unique (workspace_id, slack_user_id)
```

### people

The roster. Not the same as users. A person may or may not have a Slack account.

```
id              uuid pk
workspace_id    uuid fk → workspaces on delete cascade
name            text not null
email           text not null
slack_user_id   text                        -- matched by email, nullable
birthday_month  integer                     -- 1–12, nullable
birthday_day    integer                     -- 1–31, nullable
start_date      date                        -- nullable
team            text                        -- free-text from CSV, optional
role            text                        -- free-text from CSV, optional
opted_out       boolean not null default false
created_at      timestamptz not null default now()
updated_at      timestamptz not null default now()
unique (workspace_id, email)
```

Birthday is stored as month + day (no year) for privacy and simpler matching.

### events

Detected upcoming moments.

```
id            uuid pk
workspace_id  uuid fk → workspaces.id, on delete cascade
person_id     uuid fk → people.id, on delete cascade
kind          text not null                  -- 'birthday' | 'anniversary'
event_date    date not null                  -- the actual date this year
years         integer                        -- null for birthdays, N for anniversaries
status        text not null default 'pending'
                                             -- 'pending' | 'approved' | 'skipped'
                                             -- | 'posted' | 'cancelled'
detected_at   timestamptz not null default now()
unique (workspace_id, person_id, kind, event_date)
```

The unique constraint prevents the daily scan from creating duplicates.

### suggestions

What the agent proposed for an event. 2–3 rows per event normally.

```
id                    uuid pk
event_id              uuid fk → events.id, on delete cascade
gesture_summary       text not null           -- "Chocolate cake at standup"
gesture_details       jsonb not null          -- { vendor: "Levain", quantity: 1, etc. }
estimated_cost_cents  integer not null
rank                  integer not null        -- 1, 2, 3
created_at            timestamptz not null default now()
```

### approvals

```
id                    uuid pk
event_id              uuid fk → events.id, on delete cascade, unique
approver_user_id      uuid fk → users.id
chosen_suggestion_id  uuid fk → suggestions.id      -- nullable if skipped
custom_gesture_text   text                          -- if modified
approved_budget_cents integer
decided_at            timestamptz not null default now()
decision              text not null                 -- 'approved' | 'skipped' | 'modified'
```

### posts

```
id                  uuid pk
event_id            uuid fk → events.id, on delete cascade, unique
channel_id          text not null
slack_ts            text not null               -- the message timestamp
thread_ts           text                        -- card thread root
posted_at           timestamptz not null default now()
actual_spend_cents  integer                     -- admin-reported, nullable
spend_logged_at     timestamptz
```

### Indexes

- `people (workspace_id, birthday_month, birthday_day)` for birthday scan
- `people (workspace_id, start_date)` for anniversary scan
- `events (workspace_id, event_date, status)` for day-of trigger
- `events (status)` for the pending-approvals view

## The agent loop

The system has multiple loops. Keep them mentally separate.

### Loop 1 — Daily detection (cron, runs every morning)

```
For each workspace W:
  1. Compute today_local = current date in W.timezone
  2. Compute targets:
       - birthday_target = today_local + 7 days
       - anniversary_target = today_local + 14 days
  3. Query people in W where:
       - opted_out = false AND
       - (birthday_month, birthday_day) matches birthday_target  OR
       - start_date's month-day matches anniversary_target AND start_date < today
  4. For each match, INSERT INTO events (... ON CONFLICT DO NOTHING)
  5. For each newly created event, enqueue a `generate-suggestions` job
```

Idempotent: running it twice produces the same result.

### Loop 2 — Generate suggestions + request approval (event-triggered)

```
Given event_id:
  1. Load event, person, workspace, recent approvals history
  2. Build agent context: { person, kind, years, budget, history }
  3. Invoke agent (see "Agent design" below)
  4. Agent returns 2-3 suggestions via the propose_suggestions tool
  5. Persist suggestions to DB
  6. Build approval DM (Block Kit) with Approve/Modify/Skip buttons
  7. Send DM to the workspace's admin via Slack chat.postMessage
  8. Event status remains 'pending'
```

### Loop 3 — Approval interaction (webhook-driven)

```
On button tap from Slack:
  - Approve: write approvals row, schedule day-of-post for event_date 9am workspace time, update status 'approved'
  - Modify: open modal; on submit, write approvals row with custom_gesture_text, schedule, update status 'approved'
  - Skip: write approvals row with decision='skipped', update status 'skipped'
```

### Loop 4 — Day-of celebration (scheduled per event)

```
Given event_id:
  1. Load event + approval
  2. Post celebration message to W.celebration_channel_id
       Message draws from chosen suggestion OR custom_gesture_text
  3. Post a thread reply prompting team to sign the card
  4. Insert posts row
  5. DM the admin: "Posted! Reply with what you spent."
  6. Update event.status = 'posted'
```

### Loop 5 — Spend logging (passive, message-driven)

```
On DM to bot from admin:
  - If most recent unposted-spend event for this admin exists AND message parses as a number:
      update posts.actual_spend_cents
      reply "Logged $X. Thanks."
  - If message is `skip my birthday` from a non-admin:
      mark that person opted_out
      reply confirmation
  - Otherwise: reply with a short help message
```

## Agent design

The agent is a single Claude tool-use loop, not a multi-step plan.

**Inputs (system prompt + user prompt):**

System prompt encodes Confetti's voice and taste: warm, specific, not corny; defaults to small gestures; respects budget; avoids food-only suggestions for remote folks; varies across people in a workspace.

User prompt encodes the event:
```
Event: {birthday | anniversary, N years}
Person: {name, role, team, tenure, slack_user_id, in_office: bool}
Budget: ${default_budget}
Workspace context: {team_size, channel_culture_hints}
Past approved gestures in this workspace: [{summary, cost, when}]
Past skipped suggestions in this workspace: [{summary, why_skipped if known}]
```

**Tools the agent can call:**

| Tool | Purpose | Returns |
|---|---|---|
| `get_person_profile` | Fetch extra Slack profile fields | `{ title, location, pronouns, timezone, status }` |
| `list_recent_workspace_gestures` | What's been done lately, to avoid repeats | `[{ summary, cost, kind, when }]` |
| `propose_suggestions` | Final output. Agent must call this exactly once. | `void` (writes to DB) |

`propose_suggestions` schema:
```ts
{
  suggestions: [
    {
      summary: string,           // <= 80 chars, human-friendly
      details: object,           // free-form, structured
      estimated_cost_cents: int, // > 0, <= budget
      rationale: string,         // <= 200 chars, why this person
    }
  ] // length 2 or 3
}
```

**Constraints enforced server-side after tool returns:**
- Each suggestion cost ≤ workspace.default_budget_cents
- 2 ≤ suggestions.length ≤ 3
- No two suggestions with identical summaries
- If invalid, retry the agent once with the validation error appended

**Why a tool, not just JSON output:**
Tools give us a typed contract and let the agent reason naturally before committing. JSON-only output tends to skip the reasoning step and produce worse suggestions.

## Key invariants

These must always hold. Encode as assertions, types, or runtime checks where possible.

1. **No real money is spent in v1.** Do not import, call, or scaffold DoorDash, Amazon, Resy, or any payment SDK. If a prompt suggests it, refuse and reference this section.
2. **All date math happens in workspace timezone.** Never compare `new Date()` to a stored date directly. Use the `dates.ts` helpers.
3. **Slack bot tokens are encrypted at rest.** Never log them. Never return them from a query unless the consumer needs to call Slack right now.
4. **Slack webhook requests are signature-verified.** Bolt does this; do not bypass it.
5. **All external input is Zod-validated.** Slack payloads, CSV uploads, agent tool calls. No "trust me" objects crossing a trust boundary.
6. **Events are uniquely keyed by (workspace, person, kind, event_date).** The DB enforces this. Code may not work around it.
7. **The agent's suggestion output goes through validation before being persisted.** No raw model output reaches the DB or Slack.
8. **Opted-out people are filtered at the query layer**, not in application code. Add it to the named query, not the caller.
9. **Idempotency:** every job must be safe to run twice. Daily scan dedupes via unique constraint; day-of post checks `posts.event_id` before posting.
10. **Sensitive moments (death, illness) are not handled.** If the agent or a CSV ever surfaces something resembling this, halt and ask a human. v1 simply doesn't support it.

## Environment variables

```
# Database (Supabase Postgres)
DATABASE_URL=                 # pooled connection, port 6543, ?pgbouncer=true&connection_limit=1
DIRECT_URL=                   # direct connection, port 5432, used only by drizzle-kit migrations

# Slack app
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=
SLACK_STATE_SECRET=           # for OAuth state param

# Anthropic
ANTHROPIC_API_KEY=

# Inngest
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# Crypto
TOKEN_ENCRYPTION_KEY=         # 32 bytes base64

# App
APP_BASE_URL=                 # e.g. https://confetti.vercel.app
NODE_ENV=
```

All access through `src/lib/env.ts`, which validates with Zod at startup. Never read `process.env.X` directly elsewhere. (One narrow exception: `drizzle.config.ts` reads `DIRECT_URL` directly via dotenv so `pnpm db:*` works before all other vars are set. Comment explains why.)

## Slack app manifest

The Slack app is created at api.slack.com using `slack-manifest.yaml` at the repo root. Required scopes:

**Bot token scopes:**
- `chat:write` — post messages and DMs (only in channels the bot has been invited to)
- `channels:read` — list channels for settings
- `groups:read` — list private channels for settings
- `commands` — slash commands
- `users:read` — fetch Slack user profiles
- `users:read.email` — match CSV emails to Slack users
- `im:history` — read DMs to bot (for spend logging)
- `im:write` — open DMs

**Slash commands:** `/confetti` — settings, help, opt-out management

**Event subscriptions:** `message.im` (DM to the bot), `app_uninstalled` (clean up)

**Interactivity:** enabled, request URL = `${APP_BASE_URL}/api/slack/interactivity`

**OAuth redirect URL:** `${APP_BASE_URL}/api/slack/oauth_callback`

All manifest URLs use `${APP_BASE_URL}` placeholders. Substitute before pasting into Slack.

---

## Locked decisions

1. **Hosting:** Vercel, default region (US East / `iad1`).
2. **Database:** Supabase Postgres. We use Supabase *only* for the Postgres database in v1 — not Supabase Auth (Slack OAuth is the only auth), not Supabase Storage, not Supabase Realtime, not the JS client. Connect via the `DATABASE_URL` connection string (use the *pooled* connection string for serverless, port 6543, with `?pgbouncer=true&connection_limit=1`). Drizzle is the ORM. Keep a separate `DIRECT_URL` (port 5432) for migrations.
3. **Logging:** `console.log` / `console.error` only for v1. Use a thin wrapper `src/lib/log.ts` so we can swap in Axiom or Better Stack later without touching call sites. Wrapper signature: `log.info(msg, meta?)`, `log.warn(msg, meta?)`, `log.error(msg, meta?)`. Never log tokens or full Slack payloads — meta should be hand-picked fields.
4. **Slack app distribution:** Single-workspace dev app through end of Week 3. In Week 4, before installing to the first design partner, submit for Slack public distribution. Document the install URL in the README once approved.
5. **Domain:** `confetti.vercel.app` (or whatever Vercel auto-assigns). Set `APP_BASE_URL` to this. All Slack manifest URLs reference `APP_BASE_URL` — never hardcode the domain.
6. **Design partner:** Profound is the target. Backup plan if Profound doesn't commit by end of Week 2: ask in founder communities (e.g. South Park Commons, On Deck, YC Slack alumni groups) for a 10–50 person startup willing to be design partner #1. Do not build v1 without a named target workspace — it changes too many small decisions.

### Implications of these decisions

- **Supabase pooled connection:** In `src/db/client.ts`, use `postgres-js` (not `@supabase/supabase-js`). Drizzle works directly with `postgres-js`. Set `prepare: false` because pgBouncer in transaction mode doesn't support prepared statements.
- **Two connection strings:** `DATABASE_URL` (pooled, used by the app at runtime) and `DIRECT_URL` (direct, used by `drizzle-kit` for migrations). Both go in `.env.example`.
- **No Supabase Auth temptation:** if a prompt ever suggests `supabase.auth.*`, refuse. Slack OAuth is the only identity in v1.
- **Logging wrapper from day one:** even though it just wraps `console`, having `log.info` everywhere means a future "pipe to Axiom" is a 10-line change.
- **Public distribution submission:** allow a few days of buffer in Week 4 for Slack review. Submit early in the week.
