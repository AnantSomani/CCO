# Session 6 — Your runbook (the human steps)

> This is for YOU, not Claude Code — though Claude Code has a copy so it knows which steps are yours. These are the account/dashboard/decision tasks that can't be done from the terminal. Work through them alongside the session prompt. Claude Code drives the code; you drive the dashboards.

---

## Before you start: two decisions to tell Claude Code

1. **Prod Supabase: fresh or reuse?** Recommendation: **fresh**. Keeps dev test data out of prod. Costs ~15 min. Tell Claude Code which.
2. **Vercel account: do you have one?** If not, you'll make one in CP2.

---

## Step 0 — Submit for Slack distribution (do this FIRST, then forget about it)

It takes Slack a few days to review, so kick it off immediately and let it run in the background.

1. api.slack.com → your Confetti app → **Manage Distribution** (left sidebar)
2. Work through the checklist Slack shows (it'll want: a clear app description, support contact, privacy policy URL, redirect URLs valid, no hardcoded secrets in OAuth)
3. **Privacy policy:** you'll likely need a URL. For a v1 design-partner app, a simple one-page privacy policy is fine — Claude Code can draft one and you host it (a Vercel static page, a Notion public page, or a GitHub Pages doc). Don't overthink it, but you do need *something* at a real URL.
4. Click **Activate Public Distribution**
5. Note: Gaucho is already installed as a dev app, so distribution isn't strictly blocking session 7 — but it's free insurance and you'll want it for any second workspace. Submit now regardless.

If the checklist demands more than you can produce in 10 minutes, tell Claude Code and we'll decide whether to defer distribution to session 7 (the dev-app install at Gaucho works without it).

---

## CP1 — Database, env, Inngest accounts

### Prod Supabase (if fresh)
1. supabase.com → New Project. Name it something like `confetti-prod`. Pick a region near your users (US East is fine).
2. Set a strong DB password — **save it**, you'll need it in the connection strings.
3. Once provisioned: Project Settings → Database → Connection string.
   - **Pooled** (Transaction mode, port 6543): this is `DATABASE_URL`. Add `?pgbouncer=true&connection_limit=1` to the end.
   - **Direct** (Session mode, port 5432): this is `DIRECT_URL`.
4. Put both in your *local* `.env.local` temporarily so `pnpm db:migrate` can run against prod. **Actually** — safer: Claude Code will tell you exactly how to run the migration against prod without clobbering your dev env (probably a one-off with `DIRECT_URL` pointed at prod).
5. Run the migration as Claude Code instructs. Verify all 7 tables exist in the Supabase table editor.

### Inngest Cloud
1. inngest.com → sign up (free). Sign in with GitHub for least friction.
2. Create an app / environment (call it `confetti-prod` or use the default Production environment).
3. Find your **Event Key** and **Signing Key** (Settings → Keys, or the environment's keys page). These become `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in Vercel.
4. **Don't register the endpoint yet** — Inngest needs your Vercel URL, which doesn't exist until CP2. You'll come back to this.

---

## CP2 — Vercel

### Create / connect
1. vercel.com → sign in (use GitHub).
2. Add New → Project → import `AnantSomani/CCO`.
3. Framework preset: Next.js (should auto-detect). If pnpm isn't auto-detected, set install command to `pnpm install` and build to `pnpm build`.
4. **Don't deploy yet** — set env vars first (next step), or do the first deploy, let it fail on missing env, then add them. Either works; Claude Code will guide.

### Env vars (the fiddly part)
You'll set these in Vercel → Project → Settings → Environment Variables, for the **Production** environment. Claude Code gives you the full checklist with sources. The categories:
- **Reuse from dev:** `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_STATE_SECRET`, `ANTHROPIC_API_KEY` (these are the same app/keys)
- **New for prod:** `DATABASE_URL`, `DIRECT_URL` (prod Supabase), `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (Inngest Cloud), `APP_BASE_URL` (the Vercel URL — set *after* first deploy)
- **Decide:** `TOKEN_ENCRYPTION_KEY` — with a fresh prod DB, generate a NEW one (`openssl rand -base64 32`) and never change it. With a reused DB, must match the existing one.
- `NODE_ENV` — Vercel sets this to `production` automatically; don't override.

⚠️ **`APP_BASE_URL` is chicken-and-egg.** First deploy gives you the URL (like `cco-xxx.vercel.app`). Set `APP_BASE_URL` to it, then redeploy. Claude Code flags this.

### Deploy
1. First deploy. If it fails, read the build log — usually a missing env var or a TypeScript thing. Claude Code debugs.
2. Once green, grab the Vercel URL. Set `APP_BASE_URL`. Redeploy.

### Register Inngest endpoint (back to Inngest Cloud)
1. Inngest Cloud → your environment → **Apps** → Sync new app / add endpoint.
2. Endpoint URL: `https://<your-vercel-url>/api/inngest`
3. Inngest fetches it and should list your functions: `dailyScan`, `generateSuggestions`, `dayOfPost`, + placeholder.
4. **Verify the cron:** the daily scan should show as a scheduled cron (`0 14 * * *`). This is the proof Confetti works without your laptop. If it's listed but not scheduled, something's off — flag to Claude Code.

---

## CP3 — Slack URLs, prod install, smoke

### Flip Slack URLs to Vercel
1. api.slack.com → Confetti app → update all four URLs from `confetti-dev.anantsomani.com` to your Vercel URL:
   - OAuth & Permissions → Redirect URL → `/api/slack/oauth_callback`
   - Slash Commands → `/confetti` → `/api/slack/commands`
   - Interactivity → `/api/slack/interactivity`
   - Event Subscriptions → `/api/slack/events`
2. Save each. Event Subscriptions will re-verify against the Vercel URL — it should pass now (the route exists and is deployed).
3. ⚠️ **This breaks the tunnel-era Gaucho install.** Expected. Gaucho gets cleanly reinstalled on Vercel in session 7. Don't panic when Gaucho's bot goes quiet.

### Install prod app in YOUR dev workspace
1. Go to your Vercel URL → click Add to Slack → authorize into your **dev/sandbox** workspace (NOT Gaucho).
2. Confirm in prod Supabase: a `workspaces` row with your team, encrypted token.

### Prod smoke
- Upload a tiny test roster on the Vercel `/upload` page.
- `/confetti channel #your-sandbox` and `/confetti budget 50`.
- **Triggering the scan in prod is different** — `pnpm scan` won't work (it talks to localhost). Claude Code shows you how to trigger via the Inngest Cloud dashboard (manually invoke the scan function or send the `confetti/scan.manual` event from the Inngest UI).
- Watch it flow: events → agent suggestions (check Inngest Cloud logs + that Anthropic was called) → approval DM in your Slack → approve → day-of (trigger from Inngest dashboard) → celebration post + spend DM → reply a number → logged.
- Re-fire day-of → confirm no double-post.

### Final verification
- The `0 14 * * *` cron is **scheduled** in Inngest Cloud (not just invokable). This is the single most important check of the whole session.

---

## Things that will probably go wrong (and that's fine)

- **First Vercel build fails** — almost always a missing env var or a build-time vs runtime env access issue. Read the log, add the var, redeploy.
- **Inngest doesn't list functions** — endpoint URL typo, or `INNGEST_SIGNING_KEY` mismatch, or the deploy isn't actually live yet. Re-sync after confirming the deploy is green.
- **DB connection errors in prod** — pooled string missing `?pgbouncer=true&connection_limit=1`, or you used the direct (5432) string as `DATABASE_URL`. Swap to pooled.
- **Slash command "did not respond"** — Slack URL still points at the tunnel, or points at Vercel but the deploy is broken. Check the URL and the deploy.
- **Can't decrypt token / bot can't post** — `TOKEN_ENCRYPTION_KEY` in Vercel doesn't match what encrypted the token. With a fresh install on fresh prod DB, just reinstall after fixing the key.

None of these are real problems — they're the normal texture of a first deploy. Change one thing, verify, move on.

---

## After the session — update SESSIONS.md

Record: prod Supabase project ref, Vercel URL, Inngest Cloud app name, which env vars are new-for-prod vs reused, the new way to trigger scans in prod (Inngest dashboard, not `pnpm scan`), and the go-live note that Gaucho's tunnel install is now dead and gets reinstalled on Vercel in session 7. Future-you will thank you.
