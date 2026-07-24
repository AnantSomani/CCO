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

Run:

```bash
bash scripts/dev-stack.sh
```

What it does:

1. starts a Cloudflare quick tunnel to `http://localhost:3000`
2. extracts the tunnel URL
3. updates `APP_BASE_URL` in `.env.local`
4. starts `pnpm dev`
5. starts `npx inngest-cli@latest dev`
6. prints the exact URLs to paste into Slack and Inngest

Press `Ctrl-C` in that terminal to stop all three processes.

## What to update after each restart

Cloudflare quick tunnels change every time. After each run, copy the printed URL
into your Slack app settings:

- Slash command URL: `<APP_BASE_URL>/api/slack/commands`
- Events URL: `<APP_BASE_URL>/api/slack/events`
- Interactivity URL: `<APP_BASE_URL>/api/slack/interactivity`
- OAuth redirect URL: `<APP_BASE_URL>/api/slack/oauth_callback`

Use the same base URL for:

- `APP_BASE_URL` in `.env.local`
- the Inngest sync/serve endpoint: `<APP_BASE_URL>/api/inngest`

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

### Tunnel changed and Slack stopped working

Quick tunnels are temporary. Re-run the startup script, then update all Slack
URLs to the new `APP_BASE_URL`.
