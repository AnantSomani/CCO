# Production Runbook

Confetti runs on Vercel, Supabase Postgres, Inngest Cloud, Slack, and Anthropic.
The local Cloudflare tunnel is for development only.

## Safety model

- Each workspace has exactly one designated admin; only that person can use
  natural-language tools, inspect agent data, or approve actions.
- Read-only requests run without confirmation.
- Every mutation is persisted as a pending action and requires a Slack button approval.
- Approved actions execute through Inngest with idempotency and retries.
- Event-planning actions and `sandbox_food_order` actions are simulations only.
- Sandbox actions never contact vendors, reserve anything, or spend money.
- The optional DoorDash integration can search, create a cart, and retrieve a quote only
  after approval. It has no submit or checkout command and cannot charge a payment method.
- Keep `DOORDASH_EXECUTOR=disabled` on Vercel. Vercel cannot access a separately installed
  `dd-cli` binary or its OS-keychain credentials.

For a future production preview worker, deploy the executor on a persistent VM or managed Mac,
authenticate `dd-cli` interactively into that host's durable OS keychain, and let the worker
atomically claim approved preview actions. Require worker authentication, credential-health
monitoring, bounded retries, and a global kill switch. Real order submission must be a separate
action with a second explicit approval; it is not implemented here.

## 1. Provision production services

Create:

1. a Vercel project connected to this repository
2. a production Supabase project
3. an Inngest Cloud app
4. a production Slack app or approved distributed Slack app

Use the Vercel deployment URL or a stable custom domain for `APP_BASE_URL`.

## 2. Configure Vercel environment variables

Set every variable from `.env.example` for the Production environment:

- `DATABASE_URL`: Supabase transaction pooler URL
- `DIRECT_URL`: Supabase direct/session URL used by migrations
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_SIGNING_SECRET`
- `SLACK_STATE_SECRET`
- `ANTHROPIC_API_KEY`
- `INNGEST_EVENT_KEY`
- `INNGEST_SIGNING_KEY`
- `TOKEN_ENCRYPTION_KEY`
- `APP_BASE_URL`
- `DOORDASH_EXECUTOR=disabled`
- `NODE_ENV=production`

Never copy development Slack credentials or the local tunnel URL into production.

## 3. Apply migrations

From a trusted machine with production `DIRECT_URL`:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
```

Do this before routing Slack traffic to a deployment that expects the new schema.
The single-admin migration rejects workspaces that already contain multiple
`is_admin=true` users; resolve those rows intentionally before migrating.

## 4. Deploy and sync Inngest

Deploy the Vercel project, then register:

```text
https://YOUR_PRODUCTION_DOMAIN/api/inngest
```

Verify these functions appear in Inngest Cloud:

- `daily-scan`
- `generate-suggestions`
- `day-of-post`
- `agent-command`
- `execute-agent-action`
- `agent-audit-retention`

Production agent requests must appear as Inngest runs. If they do not, do not
enable the production Slack command.

## 5. Configure Slack

Replace the development hostname in `slack-manifest.yaml` with
`APP_BASE_URL`, then apply it to the production Slack app.

Required URLs:

- Commands: `${APP_BASE_URL}/api/slack/commands`
- Events: `${APP_BASE_URL}/api/slack/events`
- Interactivity: `${APP_BASE_URL}/api/slack/interactivity`
- OAuth redirect: `${APP_BASE_URL}/api/slack/oauth_callback`

Required bot events:

- `message.im`
- `app_uninstalled`

The App Home Messages tab must allow users to send messages.

## 6. Release checks

Run:

```bash
pnpm check
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

Then verify in a test Slack workspace:

1. `/confetti hello` responds immediately.
2. A non-admin natural-language request is rejected.
3. `/confetti what is our budget?` produces a DM through Inngest.
4. `/confetti set our budget to $75` creates an approval DM and does not update
   the database before approval.
5. Reject leaves the setting unchanged.
6. Approve updates it exactly once.
7. A sandbox food order clearly says no vendor was contacted and no money was spent.
8. Replaying the same Slack trigger or Inngest event does not duplicate actions.

## Rollback

If agent execution behaves unexpectedly:

1. disable the `/confetti` command URL in the production Slack app
2. pause `agent-command` and `execute-agent-action` in Inngest
3. leave pending actions unapproved
4. roll Vercel back to the previous deployment

Existing pending actions are inert until an authorized admin approves them.

## Data retention

Completed and failed agent runs, including their cascaded action audit rows, are
deleted after 90 days by `agent-audit-retention`. Pending or executing actions
are retained so cleanup cannot silently remove unfinished work.
