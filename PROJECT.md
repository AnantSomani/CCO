# PROJECT.md — Confetti v1

> Project scope, definition of done, build sequence, and risks. Read this in full at the start of every session along with `ARCHITECTURE.md` and `CONVENTIONS.md`. If anything in this document conflicts with a prompt, ask before deviating.

---

## What Confetti is

Confetti is a Slack-native AI agent that quietly runs the joyful parts of a company's culture, starting with celebrating birthdays and work anniversaries.

The thesis: it's not the perks, it's the *someone* who remembers. Confetti is that someone, for growing teams where People Ops is one person stretched thin or doesn't exist yet.

## v1 in one sentence

When a teammate's birthday or work anniversary is approaching, Confetti DMs a workspace admin in Slack with 2–3 suggested gestures and an estimated budget; the admin approves with one tap; Confetti posts a celebration to a chosen channel on the day and opens a "sign the card" thread.

## v1 user stories

**As an admin installing Confetti:**
- I can install the Slack app via OAuth in under 60 seconds.
- I can upload a CSV of my team with names, emails, birthdays, and start dates.
- I can pick a celebration channel and a default per-event budget via a slash command, and mark people as opted-out without removing them.

**As an admin during normal operation:**
- One week before a teammate's birthday, I get a DM from Confetti with 2–3 suggested gestures, each with an estimated cost.
- I can tap Approve, Modify, or Skip without leaving Slack.
- If I tap Modify, I get a simple modal to change the gesture text and budget.
- On the day of the event, Confetti posts a celebration message to the chosen channel and opens a thread for the team to sign.
- After Confetti posts, it DMs me asking what I actually spent so the budget log stays honest.

**As a teammate being celebrated:**
- I see a warm, specific message in the celebration channel on my birthday or anniversary.
- I can DM Confetti `skip my birthday` and it will not surface me again this cycle.

## What is explicitly NOT in v1

These are deferred to v2+. Do not build them, propose them, or design around them in v1:

- Real purchasing integrations (DoorDash, Amazon, Resy, OpenTable). Spend is admin-reported only.
- Activities, trivia, Nerf wars, ice cream carts, scavenger hunts. Only birthdays and work anniversaries.
- Cross-office travel matching.
- HRIS sync (Rippling, Gusto, Workday). CSV upload only.
- ~~Web dashboard. Everything happens in Slack.~~ **Revised (2026-08):** a
  minimal, Slack-OAuth-gated **roster dashboard** (`/dashboard`) is now in
  scope for adding/editing people, birthdays, and work anniversaries — a
  friendlier alternative to CSV for non-technical admins. Approvals,
  suggestions, and celebrations still happen entirely in Slack; the dashboard
  is data-entry only.
- Multi-admin approval flows. One admin per workspace approves everything.
- Billing, Stripe, plans, trials. v1 is free for design partners.
- Sympathy moments, illness, layoffs, weddings, new babies. Sensitive moments are deferred until we have time to design them with care.
- Generic "team energy" detection. No mood sensing.
- Multiple celebration channels per workspace.
- Per-person budget overrides.

If a feature is not on the in-scope list, it is out of scope. Do not silently include it.

## Definition of done for v1

Confetti v1 is done when **all** of the following are true:

1. The Slack app can be installed in a fresh workspace via OAuth.
2. An admin can upload a CSV of at least 50 people without errors.
3. The daily scan correctly detects birthdays 7 days out and anniversaries 14 days out, in the workspace's timezone, with no duplicates across runs.
4. The agent produces 2–3 distinct, sensible suggestions per event with cost estimates within the workspace's budget.
5. Admin DMs render correctly with Approve, Modify, Skip buttons that all work.
6. The Modify modal captures custom gesture text and budget.
7. The day-of post fires at 9am workspace-local time on the event date, in the right channel.
8. The post opens a thread with a card-signing prompt.
9. The admin gets a follow-up DM asking for actual spend and can reply with a number that gets logged.
10. An opt-out flag on a person prevents all of the above for that person.
11. The `/confetti` slash command works for settings: channel, budget, list opt-outs.
12. The app can be installed in at least one external Slack workspace by a non-engineer following written instructions.
13. The repo has working tests for the date logic, the agent tool layer, and the Slack event handlers.
14. No real money is spent. No external purchasing APIs are called.

## Non-goals for the v1 codebase

- Beautiful UI. There is almost no UI; what little exists (CSV upload page) can be plain.
- Performance at scale. v1 targets workspaces under 200 people. Do not pre-optimize for 10,000-person tenants.
- Multi-region. One Vercel region is fine.
- Internationalization. English only.
- Comprehensive analytics. Log enough to debug; do not build dashboards.

## Design partners and feedback loop

v1 ships to 1–3 friendly companies. After install, we expect to iterate weekly based on what those admins do and do not approve. The agent's suggestion quality is the part most likely to need tuning, so the system prompt and suggestion logic should be easy to change without touching plumbing.

---

## Build sequence

Assume ~15–20 focused hours per week. Each week ends with a working, committable, demoable slice.

### Week 1 — Foundations & Slack install

**Goal:** the bot installs in a real workspace and responds to a slash command.

1. Init repo, Next.js 15 + TypeScript + pnpm + Biome + Vitest.
2. Add this document, split into PROJECT.md / ARCHITECTURE.md / CONVENTIONS.md.
3. Set up Supabase Postgres + Drizzle. Create initial migration with all 7 tables.
4. Set up Inngest local dev (`npx inngest-cli dev`).
5. `src/lib/env.ts` with Zod validation.
6. `src/lib/crypto.ts` with AES-256-GCM encrypt/decrypt for tokens.
7. `slack-manifest.yaml` at repo root; create Slack app in api.slack.com.
8. Implement `GET /api/slack/install` (redirect to Slack with state).
9. Implement `GET /api/slack/oauth_callback` (exchange code, encrypt token, upsert workspaces + users rows).
10. Implement `POST /api/slack/commands` and handle `/confetti hello` to reply with workspace name.
11. Deploy to Vercel, install in your own Slack workspace.
12. Tests for env validation and crypto round-trip.

**Done when:** you can install the bot fresh in your workspace and `/confetti hello` replies with your team name.

### Week 2 — Roster & event detection

**Goal:** tomorrow morning, a fake event lands in the DB.

1. `src/lib/csv.ts` with Zod row schema (name, email, birthday_mmdd, start_date YYYY-MM-DD).
2. `/upload` page, Slack OAuth-gated, accepts a CSV, parses, validates, upserts people rows.
3. `src/lib/dates.ts` with timezone-aware helpers: `daysUntilBirthday`, `daysUntilAnniversary`, `isSameLocalDate`.
4. `src/jobs/daily-scan.ts` Inngest cron at `0 9 * * *` per workspace timezone (or 14:00 UTC as v1 simplification — see below).
5. Job logic: for each workspace, find people with birthday in 7 days or anniversary in 14 days; insert events with ON CONFLICT DO NOTHING.
6. Inngest manual-trigger event `confetti/scan.manual` for local testing.
7. Tests for `dates.ts` and `daily-scan.ts` including DST and Feb-29 edge cases.

**v1 simplification on cron timing:** run the scan once daily at 14:00 UTC. Per-workspace local-time cron is a v2 polish. Add a TODO with this note in the job file.

**Done when:** running the manual trigger creates events for the right people on the right dates, with no duplicates on a second run.

### Week 3 — Approval flow

**Goal:** full plumbing works end-to-end with hardcoded suggestions.

1. `src/slack/ids.ts` with action_id and callback_id constants.
2. `src/slack/blocks/approval-dm.ts` builds the DM with three buttons.
3. `src/jobs/generate-suggestions.ts` — for now, insert 2 hardcoded suggestions per event and send the approval DM.
4. `POST /api/slack/interactivity` routing to handlers in `src/slack/handlers/actions.ts`.
5. Handle `approve_event` button → write approvals row, schedule `day-of-post` Inngest event for event_date 14:00 UTC, update event status.
6. Handle `skip_event` button → write approvals row with decision='skipped'.
7. Handle `modify_event` button → open modal (`src/slack/blocks/modify-modal.ts`).
8. Handle modal submit in `src/slack/handlers/views.ts` → write approvals row with custom text.
9. `src/jobs/day-of-post.ts` scheduled job that posts celebration + opens thread + DMs admin for spend.
10. `src/slack/handlers/messages.ts` handles DMs: parse a number from admin → log spend; parse `skip my birthday` from anyone → set opted_out.
11. Tests for each action handler with a mocked Slack client.

**Done when:** trigger a manual scan in dev, get a DM, tap Approve, fast-forward the day-of job, see the celebration post and thread, reply with `42`, see it logged.

### Week 4 — The agent + polish + ship

**Goal:** real suggestions, settings, ship to one external workspace.

1. `src/agent/prompt.ts` system prompt. Iterate on tone.
2. `src/agent/tools.ts` with `get_person_profile`, `list_recent_workspace_gestures`, `propose_suggestions`.
3. `src/agent/index.ts` runs the loop with 5-round cap and one validation retry.
4. Wire `generate-suggestions.ts` to call the agent instead of hardcoded suggestions.
5. Improve `/confetti` slash command: subcommands `setup`, `channel <id>`, `budget <usd>`, `opt-outs`, `help`.
6. `/confetti setup` walks a first-time admin through picking a channel and budget via a modal.
7. Add `app_uninstalled` event handler to clean up workspace data (or soft-mark; decide and document).
8. Write a 1-page install guide for a non-engineer admin.
9. Install in one external workspace; load their CSV; let it run for a week.
10. Add structured logging for every agent call to a `logs/` directory or external service.

**Done when:** an external admin successfully installs, uploads, and approves at least one real event end-to-end without your help.

### Week 5+ (post-v1)

Out of scope for this plan, but likely next:
- HRIS sync via Merge or direct Rippling/Gusto.
- Activities (the second product pillar).
- Real purchase execution starting with DoorDash gift cards.
- Web dashboard for approvals history and budget tracking.
- Multi-admin approvals.

---

## Risks and how to handle them

**Risk: timezones break in subtle ways.**
Mitigation: every date helper takes timezone explicitly, no defaults. Test cases include DST transitions and Feb 29.

**Risk: the agent produces tone-deaf suggestions.**
Mitigation: log every agent invocation. Review the first 50 in week 4. Iterate the system prompt before showing to external workspaces.

**Risk: Slack API rate limits during bulk operations.**
Mitigation: v1 is small workspaces; defer real handling. Add a TODO in the Slack client.

**Risk: an admin approves something that costs more than expected.**
Mitigation: v1 has no real spend. The "approved budget" is informational. The admin reports actual spend after the fact.

**Risk: a CSV with bad data poisons the DB.**
Mitigation: Zod-validate every row; reject the whole upload on any error in v1 and report the row numbers. Idempotent re-upload.

**Risk: encryption key rotation.**
Mitigation: out of scope for v1. Document the limitation. Key rotation lands in v2.

**Risk: someone uninstalls and reinstalls.**
Mitigation: OAuth callback upserts on `slack_team_id`, refreshing the token. Existing people/events remain.

**Risk: the agent calls `propose_suggestions` zero times or many times.**
Mitigation: server-side enforcement after the loop ends. If zero, retry once. If more than one, take the last call. If still invalid after retry, fall back to a hardcoded "card from the team, $30" suggestion and log the failure loudly.
