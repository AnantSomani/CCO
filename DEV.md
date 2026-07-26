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
