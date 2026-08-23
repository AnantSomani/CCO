# Dev Setup

This project has two separate surfaces:

- the marketing site in `landing/`
- the Slackbot/backend in the Next.js app at the repo root

This file is for the Slackbot/backend dev flow.

## Prerequisites

- `pnpm`
- `cloudflared`
- valid values in `.env.local`
- a Slack app configured for this project

## One-command startup

After pulling migrations or schema changes, run once:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
```

Run:

```bash
bash scripts/dev-stack.sh
```

What it does:

1. sets `APP_BASE_URL` to `https://dashboard.tryconfetti.xyz`
2. starts `pnpm dev`
3. starts `npx inngest-cli@latest dev`
4. starts the named Cloudflare tunnel `confetti-dev`
5. prints the stable Slack and Inngest URLs

Press `Ctrl-C` in that terminal to stop all three processes.

If your local tunnel credentials JSON is missing, you can still use the script
with a tunnel token:

```bash
CLOUDFLARED_TUNNEL_TOKEN="$(cloudflared tunnel token confetti-dev)" bash scripts/dev-stack.sh
```

## One-time Cloudflare setup

Before the script will work with a fixed hostname, you need to set up the named
tunnel once:

```bash
cloudflared tunnel login
cloudflared tunnel route dns confetti-dev dashboard.tryconfetti.xyz
```

Then create `~/.cloudflared/config.yml`:

```yaml
tunnel: 9ceca87c-4a5d-45d8-ba34-3348dd7e8e5c
credentials-file: /Users/arultrivedi/.cloudflared/9ceca87c-4a5d-45d8-ba34-3348dd7e8e5c.json

ingress:
  - hostname: dashboard.tryconfetti.xyz
    service: http://localhost:3000
  - service: http_status:404
```

If you are using the token-based startup command instead, the script does not
need the local tunnel credentials JSON file.

## Slack and Inngest URLs

Because the hostname is fixed, these should stay the same:

- Slash command URL: `<APP_BASE_URL>/api/slack/commands`
- Events URL: `<APP_BASE_URL>/api/slack/events`
- Interactivity URL: `<APP_BASE_URL>/api/slack/interactivity`
- OAuth redirect URL: `<APP_BASE_URL>/api/slack/oauth_callback`

Use the same base URL for:

- `APP_BASE_URL` in `.env.local`
- the Inngest sync/serve endpoint: `<APP_BASE_URL>/api/inngest`

If you want to use a different tunnel name or hostname later, you can override
the defaults:

```bash
CLOUDFLARED_TUNNEL_NAME=my-tunnel CLOUDFLARED_HOSTNAME=dev.tryconfetti.xyz bash scripts/dev-stack.sh
```

You can combine that with the token flow too:

```bash
CLOUDFLARED_TUNNEL_NAME=my-tunnel CLOUDFLARED_HOSTNAME=dev.tryconfetti.xyz CLOUDFLARED_TUNNEL_TOKEN="$(cloudflared tunnel token my-tunnel)" bash scripts/dev-stack.sh
```

## Dev checklist

Once the stack is up:

1. open the app root in the browser
2. install/reinstall the Slack app
3. run `/confetti hello`
4. run `/confetti channel #your-channel`
5. run `/confetti budget 50`
6. upload a CSV at `/upload`
7. trigger a scan with:

```bash
pnpm scan
```

8. look for the approval DM from Confetti in Slack

## Test the admin agent

Natural-language commands run through the local Inngest server and reply by DM.
The requesting Slack user must be an admin in Confetti's `users` table.

Read-only test:

```text
/confetti what is our current budget?
```

Mutation test:

```text
/confetti set our default budget to $75
```

The mutation must not happen immediately. Confetti should DM an approval card;
only the Approve button may enqueue execution.

Sandbox planning test:

```text
/confetti plan a sandbox order for five large pizzas from Local Pizza for 20 people at 123 Market St, San Francisco, CA on August 12 at 11am PT for about $40
```

The final result must say that no vendor was contacted and no money was spent.

DoorDash preview test (opt-in):

1. Run `dd-cli login`.
2. Set `DOORDASH_EXECUTOR=dd-cli` in `.env.local`.
3. Restart `bash scripts/dev-stack.sh`; startup verifies the CLI and saved credentials.
4. Send a request naming one exact restaurant, exact menu items and quantities, a delivery
   time, and a maximum total such as `$90`.
5. Confirm that Confetti searches the live menu, asks for clarification instead of guessing
   ambiguous items or customizations, and sends a preview approval card.
6. Approve once. The result may create a DoorDash cart and must show the live quote, while
   explicitly stating that no order was submitted and no payment method was charged.
7. Verify in DoorDash that there is an open cart and no new order in order history.

DoorDash preview is disabled by default. The integration has no code path for `order submit`
or `order checkout-url`.

## Common issues

### `/api/inngest` says the SDK response was not signed

That is expected if the app is in dev mode and you try to use Inngest Cloud
sync like a production deploy. Use the local Inngest dev server instead.

### `pnpm scan` returns `candidates: 0`

The scan uses the workspace timezone, not your laptop timezone. Make sure the
CSV dates are aligned to:

- birthdays at `today + 7`
- anniversaries at `today + 14`

in the workspace timezone.

### The named tunnel failed to start

Make sure all of these are true:

- `cloudflared tunnel list` shows `confetti-dev`
- `dashboard.tryconfetti.xyz` is routed to the tunnel

If you are using the credentials-file flow, also make sure:

- `~/.cloudflared/config.yml` exists
- `~/.cloudflared/9ceca87c-4a5d-45d8-ba34-3348dd7e8e5c.json` exists

If you are using the token flow, make sure `CLOUDFLARED_TUNNEL_TOKEN` is set
when you run the script.
