# Confetti — session log

A running log of build sessions. Newest at the top.

---

## 2026-05-21 — Session 5: the real agent (Week 4, Part A)

**Goal achieved:** `hardcoded.ts` is gone; `generate-suggestions.ts` runs the real Claude tool-use agent. The agent produced 10 tasteful, varied, person-appropriate, in-budget suggestions for a varied test corpus (5 birthdays, 5 anniversaries across roles/tenures from 5-day new-hire to 10-year principal). Voice reads as "thoughtful friend who happens to be organized" per spec. 191/191 tests, typecheck clean, biome clean.

**What landed**
- `src/agent/types.ts` — `AgentEvent`, `AgentPerson`, `AgentWorkspace`, `AgentToolCall`, `AgentResult` (discriminated union: `ok:false` for precondition failures, `ok:true` with `usedFallback` flag for everything else)
- `src/agent/model.ts` — single-file constants: `AGENT_MODEL = 'claude-sonnet-4-6'`, `AGENT_MAX_TOKENS = 2048`, `AGENT_TIMEOUT_MS = 30000`, `MAX_ROUNDS = 5`, `FORCE_TERMINAL_ROUND = 5`
- `src/agent/prompt.ts` — `SYSTEM_PROMPT` (~1.2KB). Taste principles, how-to-work, hard rules. Explicit allowance for `estimated_cost_cents: 0` so the model doesn't fake `1` for free gestures
- `src/agent/tools.ts` — three tools with Anthropic JSON Schema + Zod parser side-by-side. `proposeSuggestionsInputSchema`, `getPersonProfileInputSchema`, `listRecentGesturesInputSchema`. `validateProposeBusinessRules` enforces budget cap + duplicate-summary detection (case + whitespace insensitive)
- `src/agent/index.ts` — `runAgent({ anthropic, slackClient?, listRecentGestures?, event, person, workspace, log? })`. 5-round cap; force-terminal-round 5 ships only `propose_suggestions` with `tool_choice: { type: 'tool', name: ... }`; validation pass (Zod then business rules) with 1 retry; safe fallback (`"Card from the team"` at `min(3000, budget)`) on any failure; 30s `AbortController` timeout; defensive unwrap for the model's occasional double-encoded-string `suggestions`; `get_person_profile` enriches with optional Slack `users.info` and degrades gracefully when it fails
- `src/agent/anthropic-client.ts` — `getAnthropicClient()` factory + `GetAnthropicClient` type (mirrors `GetSlackClient` for boundary-mocking)
- `src/agent/logging.ts` — `appendAgentRunLog` JSONL appender. `logs/agent-YYYY-MM-DD.jsonl` in dev (sync writes — see decision), structured console line in prod, no-op in test
- `src/jobs/generate-suggestions.ts` — swapped `generateHardcodedSuggestions` → `runAgent`. Closure-binds `listRecentApprovedGestures(db, workspace.id, n)` so agent stays DB-agnostic. Threads `usedFallback` through the run result
- `src/db/queries/approvals.ts` — added `listRecentApprovedGestures(db, workspaceId, limit)`. Returns approved + modified gestures newest first, falls back to `customGestureText` on modified rows
- `src/slack/client.ts` — added `usersInfo(slackUserId)` to `SlackClient` (GET form, follows the `conversations.info` precedent). Returns `{id, name, realName, title, pronouns, timezone}`
- `tests/anthropic-stub.ts` — scripted Anthropic stub. `scriptedAnthropic(steps)` plays back pre-built responses; `messageWithToolUses`, `proposeMessage`, `messageTextOnly` helpers; `stubSlackClient(overrides?)` for context-tool tests. Snapshots `params.messages` at capture time (the agent mutates the array between rounds)
- `tests/agent-tools.test.ts` — Zod validation + business rules (22 tests including cost=0 allowed, rationale ≤280, duplicate summary detection)
- `tests/agent-loop.test.ts` — 14 tests covering happy paths, validation retry, persistent invalid → fallback, force-terminal mechanic, API error → fallback, precondition failure, never-zero invariant (parameterized over 3 failure modes), and defensive JSON-string unwrap
- `tests/agent-context-tools.test.ts` — 10 tests covering `get_person_profile` (DB-only / graceful degradation / Slack enrichment / null tenure) and `list_recent_workspace_gestures` (provider passes, limit, empty default)
- `tests/jobs-generate-suggestions.test.ts` — rewritten to inject a mocked agent (`mockAgent(result)`). Covers happy path, fallback path persists single suggestion + still DMs, precondition failure short-circuits without DM, idempotency, missing event
- `roster.csv` — replaced 3-person demo with the **10-person varied tuning corpus** that lived in `scripts/seed-tuning.ts` during CP3. Dates calibrated for 2026-05-21 (birthdays at `05-28`, anniversaries at `06-04` with milestones at 1/2/3/5/10 years)
- `logs/.gitignore` — `*.jsonl` so JSONL doesn't get committed
- Deleted: `src/agent/hardcoded.ts`, `tests/agent-hardcoded.test.ts`, `scripts/anthropic-sanity.ts` (one-shot key check), `scripts/seed-tuning.ts` + `scripts/_check-missing.ts` (CP3 utilities)
- Test count: **191** (+44 net — added agent tests, deleted 4 hardcoded tests)
- **Commit `45cae21`** pushed to `origin/main` (21 files, +2226 −158)

**Decisions made today**
- **Model pinned in `src/agent/model.ts`** as a single constant — one diff to swap. `claude-sonnet-4-6` per ARCHITECTURE.md
- **`db` dropped from `RunAgentArgs`** (spec suggested it). The agent stays DB-agnostic; wiring layer in `generate-suggestions.ts` closes `listRecentApprovedGestures` over `db + workspace.id` and passes the closure. Lower test friction (no pglite needed for unit tests of the loop) and cleaner boundary
- **`listRecentGestures` is an optional provider** — empty array if absent. Tests stub it; production wiring binds the DB query
- **Fallback returns 1 suggestion**, not 2-3. Per spec. Downstream `insertSuggestions` + `buildApprovalDM` iterate, so 1 row renders fine. Logged with `error` field carrying the reason so JSONL captures *why* it fell back
- **`estimated_cost_cents: 0` is allowed.** First tuning run had the model setting `1` cent for free gestures (Slack thread, half-day off, playlist). Relaxed Zod to `.nonnegative()` and added prompt line explicitly inviting `0` for free gestures
- **Rationale max bumped 200→280** after first tuning run showed the model wasting a retry round on rationales that ran ~210-220 chars. JSON Schema description updated to "Keep it brief — 1-2 sentences"
- **Defensive JSON-string unwrap on `propose_suggestions.suggestions`** — observed during tuning: model occasionally double-encodes the array as a JSON string. We `JSON.parse` it before Zod. Quality content underneath; just the wrong wire format. Test covers it
- **Sync writes for JSONL** (`appendFileSync`). `fs.promises.appendFile` under O_APPEND is only atomic up to ~PIPE_BUF (~512B on macOS) — our 2-3KB JSON lines silently lost 2/10 rows when ~10 agent runs finished in parallel. Sync per-line is fine at dev volume
- **Skip JSONL writes in `NODE_ENV=test`** — first tuning run found 3 stale "Alice Park" entries in the dev log from earlier test runs. Cleaner separation now
- **Agent uses Slack `users.info` via the same client as everything else.** Added `usersInfo` to `SlackClient` (GET form, matches the `conversations.info` precedent from session 4)
- **3-checkpoint cadence held**: CP1 (types + model + prompt + tools + loop + 43 unit tests w/ scripted Anthropic) → CP2 (factory + JSONL + recent-gestures query + wire-in + delete hardcoded + 5 wiring tests) → CP3 (10-person tuning corpus + 3 iterations: log concurrency fix → rationale cap bump → cost=0 allowed → defensive JSON-string unwrap → final clean run)

**Tuning observations (CP3 — for future tone calibration)**
- **Voice is on target.** Sample rationales: *"Sales can be a grind, and genuine peer recognition hits differently than a gift"* (AE), *"A 2-year mark is when people start asking 'is this the right place for me?'"* (CSM), *"Five years leading Ops means a lot of behind-the-scenes impact that often goes unacknowledged"* (Head of Ops), *"After 10 years, Jude has earned breathing room more than another object"* (Principal Eng). Specific, observational, warm without saccharine — matches spec
- **Variety holds across the workspace.** Designer → typography books; Marketing Lead → "The Brand Gap"; Engineer → engineering book; Principal Engineer → "Decade in Code" GitHub viz; Customer Success → leadership recognition note. Agent actively reads workspace history via `list_recent_workspace_gestures` and *names* the recent DoorDash gift card pattern in rationales as a thing to avoid
- **Tenure context is used correctly.** 5-day new hire (Priya) got the quietest gestures with explicit note that loud surprises feel overwhelming; 10-year principal got "earned breathing room"; 1-year co-founder got "first year is worth marking with something tangible"
- **Zero-cost gestures get used heavily (15/28 final suggestions across one full run).** Slack threads, half-days off, team-curated playlists, video retrospectives, named appreciations. Healthy signal that the model values "small and genuine" over "expensive"
- **3 rounds is normal for happy-path runs** — model calls `get_person_profile` + `list_recent_workspace_gestures` in round 1, then `propose_suggestions` in round 2. Round 3 only when validation retry fires (now rare after the cost=0 + 280-char fixes)
- **Latency: ~10-15s per run, ~$0.02-0.05 per call.** 10 events processed in parallel in ~30s wall time. Well within Inngest job budget

**Pre-Session-6 to-do**
1. Tunnel up: `cloudflared tunnel run confetti-dev`
2. `pnpm dev` + `npx inngest-cli@latest dev`
3. `git pull && pnpm db:migrate` (ritual)
4. If re-running tuning: `pnpm scan` will create events for the 10 fixture people in `roster.csv` (idempotent — won't re-fire if events already exist). To start fresh, delete the test events in Drizzle Studio
5. Confirm `ANTHROPIC_API_KEY` works (Session 5 burned through ~$0.50 of API across 3 tuning runs of 10 events each)

---

## 2026-05-18 — Session 4: approval flow + day-of post + spend logging (Week 3)

**Goal achieved:** Full approval flow plumbing works end-to-end with hardcoded suggestions. `pnpm scan` → 2 events created → 2 DMs with Approve/Modify/Skip → tap Approve (DM updates in place, day-of scheduled) → tap Modify (modal opens with prefilled gesture+budget; submit writes `decision='modified'`) → fired `confetti/day-of.scheduled` manually in Inngest UI → celebration post + thread + admin DM ("Posted for ...! Reply here...") in `#sandbox` → DM `45` → "Logged $45 for You. Thanks." (`posts.actual_spend_cents=4500`) → re-fired the same event → `{posted: false, reason: 'already_posted'}`, no double-post.

**What landed**
- `src/slack/blocks/` — `approval-dm.ts` (header + per-suggestion section + 3-button actions; `buildApprovalResolvedDM` for in-place chat.update post-tap), `modify-modal.ts` (plain_text_input + number_input, eventId in `private_metadata`), `celebration-post.ts` (warm template + optional gesture context block, `CARD_THREAD_PROMPT`)
- `src/slack/handlers/` — `commands.ts` (lifted from inline route; added `/confetti channel`, `/confetti budget`, `/confetti opt-outs`, `/confetti help`), `actions.ts` (approve / modify-open / skip; double-tap idempotency via `insertApproval`'s null-on-conflict), `views.ts` (modify submit; Zod-validates `private_metadata`; returns `validation_error` discriminated variant so route renders Slack's `response_action: errors`), `messages.ts` (lenient money parser `45` / `$45.50` rejects `forty-five`; `skip my birthday` / `include my birthday`; admin+unlogged-post gating for spend; bot-loop + thread-reply filters)
- `src/jobs/` — `generate-suggestions.ts` (pure `runGenerateSuggestions` + Inngest wrapper triggered on `confetti/event.created`; stashes DM channel+ts on event row), `day-of-post.ts` (pure runner + Inngest wrapper triggered on `confetti/day-of.scheduled`; **4 idempotency guards** — no approval, skipped, post exists, no celebration channel), `daily-scan.ts` updated to emit `confetti/event.created` per newly-created event
- `src/db/queries/` — new: `suggestions.ts`, `approvals.ts` (idempotent on `event_id` unique constraint, returns null on conflict), `posts.ts` (idempotent on `event_id`; `findMostRecentUnloggedPostForWorkspace` for the spend matcher); extensions: `events.ts` (`getEventForApproval` joined bundle, `updateEventStatus`, `setEventApprovalMessage`), `workspaces.ts` (`getAdminUser`, `setCelebrationChannel`, `setDefaultBudget`), `people.ts` (`findPersonBySlackUserId`, `setOptedOutBySlackUser`, `listOptedOut`)
- `src/agent/hardcoded.ts` — **TODO: replace with real agent in session 5**; 2 templates per kind, first-name substitution, clamp-to-budget with `log.warn`
- `src/app/api/slack/interactivity/route.ts` + `src/app/api/slack/events/route.ts` — raw-body signature verify (events route skips signature on the URL-verification challenge), Zod-discriminated routing
- `src/slack/client.ts` — `chatUpdate`, `viewsOpen`, `conversationsInfo` + `GetSlackClient` factory type
- Schema migration `0002_stale_rockslide.sql` — adds `events.approval_dm_channel_id` + `events.approval_dm_ts` (stash for chat.update target)
- Tests: 8 new files (blocks ×3, agent-hardcoded, queries ×3, handlers ×3, jobs ×2) + `slack-stub.ts` shared recording fake + extended `daily-scan.test.ts`. 27 new tests, **147 total**
- `vitest.config.ts` — `testTimeout: 30000` (pglite cold-start was flaking under load)
- `slack-manifest.yaml` — now points at the **permanent** `confetti-dev.anantsomani.com` named Cloudflare tunnel (no more rotating quick-tunnel URLs)
- **Commit `c8e7fe5`** pushed

**Decisions made today**
- **Stash approval-DM channel+ts on the event row** (2 nullable cols) — simplest of the 3 options (event row vs suggestions vs Slack lookup); lifecycle matches event exactly, single source of truth, no FK juggling
- **`getSlackClient` factory injected into jobs/handlers via `GetSlackClient` function type** — matches CONVENTIONS "mock at the `getSlackClient` boundary"; tests pass `recordingSlackClientFactory` from `tests/slack-stub.ts`
- **Day-of scheduled at 14:00 UTC on `event_date`** via `inngest.send({name, ts: futureMs, data})` (Inngest's `ts` field is delivery time when in the future). Per-workspace 9am-local is a v2 polish per ARCHITECTURE.md
- **Approval idempotency via existing UNIQUE constraint on `approvals.event_id`** — `insertApproval` uses `onConflictDoNothing().returning()` and treats empty-return as "already decided, no-op"; handler still refreshes DM to reflect current state
- **Hardcoded suggestion provider clamps cost to workspace budget** — agent in session 5 will respect budget natively, but hardcoded $120 lunch can't blow through a $50 default. Logs `log.warn` when clamped so we see it in dev
- **Three-checkpoint cadence held**: CP1 (schema migration + queries + Block Kit + hardcoded + tests) → CP2 (routes + handlers + jobs wired + tests) → CP3 (E2E smoke + commit)
- **Lift commands handler at CP2, not deferred again** — Session 2 said "lift when real subcommands land." Session 4 added 3 real subcommands, so the lift happened. Route is now a thin signature-verify + delegate wrapper

**Bugs found + fixed during the smoke (good reference for session 5+)**
- `conversations.info` rejects JSON body → switched to GET with query string (`callGet` helper). Other Slack methods kept JSON
- `views.open` requires `view` argument as **JSON-encoded string** even when posting JSON, per `@slack/web-api` SDK convention — passing a nested object yields `invalid_arguments` with no specific message
- `number_input` rejects `"50.00"` (trailing zeros) — `formatUsdInput` now uses `Number().toString()` so 5000 → `"50"`, 4250 → `"42.5"`
- Slack API errors now log `response_metadata.messages` — first place to look for `invalid_arguments` diagnostics

**Infra / dev environment**
- **Permanent dev tunnel** via Cloudflare named tunnel `confetti-dev` (UUID `9ceca87c-4a5d-45d8-ba34-3348dd7e8e5c`); config at `~/.cloudflared/config.yml`; run with `cloudflared tunnel run confetti-dev`. Resolves to `https://confetti-dev.anantsomani.com`. **No more updating Slack URLs every restart.**
- `anantsomani.com` DNS now hosted on Cloudflare (free; domain bought on Cloudflare Registrar)
- Initial migration miss caught by `42703` (undefined_column) from a daily-scan failure — added to forward-looking notes below
- Pre-session-4 to-do (Messages tab + tunnel) was already done before session started

**Smoke fixture (for session 5 reference)**
`roster.csv` was updated mid-session to align with new "today" (2026-05-19); current contents:
```
name,email,birthday,start_date
You,you@example.com,05-26,
You Anniversary,anniv@example.com,,2023-06-02
Opt Outter,opt@example.com,05-26,
```
Dates: birthday +7, anniversary +14 (3 years out). **Regenerate for new "today" before Session 5 smoke.** Still untracked.

---

## 2026-05-12 — Sessions 1, 2 & 3: foundation + Slack OAuth + roster/event detection

### Session 1 — Week 1 foundation pass

**Goal achieved:** Repo bootstrapped, schema migrated to Supabase, Inngest local dev working, env validation + token encryption tested.

**What landed**
- Next.js 15.5.18 + TypeScript strict (`noUncheckedIndexedAccess`) via pnpm
- Biome 2 + Vitest 4 configured
- Drizzle schema with 7 tables migrated to Supabase (`0000_wooden_amphibian.sql`)
- `src/lib/{env,crypto,log,result}.ts` — AES-256-GCM token encryption + Zod env validation, 15 tests passing
- Inngest webhook at `/api/inngest` with one placeholder function
- `slack-manifest.yaml` at repo root
- Build plan split into `PROJECT.md` / `ARCHITECTURE.md` / `CONVENTIONS.md`
- `README.md` with local setup instructions
- **Commit `fe2122c`** pushed to https://github.com/AnantSomani/CCO

**Decisions / fixes applied**
- Working directory: `/Users/anantsomani/CCO/CCO-1` (treated as the fresh-empty dir; pre-existed with `.git` only)
- Pinned Next.js to `^15` (latest tag pulled 16.x; plan locks Next 15, CONVENTIONS forbids auto-upgrade)
- **Schema fix**: `workspaces` table is now `id uuid pk + slack_team_id text unique` (plan had it malformed as `id text not null` with no separate team id)
- **Typo fix**: `events.kind` is `'birthday' | 'anniversary'` (plan had `'ary'`)
- 3-checkpoint cadence agreed for both sessions (manifest sanity + DB setup + commit), not per-step
- `drizzle.config.ts` reads `DIRECT_URL` via dotenv directly — one documented exception to the "all env through `src/lib/env.ts`" rule, so `pnpm db:*` works before all other env vars are filled
- Inngest client uses `isDev: env.NODE_ENV !== 'production'` to avoid the "Expected server kind cloud, got dev" mismatch when `INNGEST_*` env vars are set to placeholders locally

**Environment quirks worth remembering**
- Chrome 130+ blocks local network access to `local.drizzle.studio` by default — toggle "Local network access" in the site info dropdown
- Inngest dev server auto-discovery requires `isDev: true` on the client, not just absence of signing keys

---

### Session 2 — Slack OAuth + `/confetti hello`

**Goal achieved:** End-to-end Slack install in the user's workspace; `/confetti hello` returns the workspace name. Reinstall (uninstall → reinstall) verified to update in place (no duplicate row).

**What landed**
- `src/slack/state.ts` — HMAC-signed OAuth state param (CSRF protection), 10-min expiry, base64url wire format
- `src/slack/signing.ts` — Slack request signature verification, `timingSafeEqual`, 5-min timestamp skew rejection
- `src/slack/schemas.ts` — Zod for slash payload, OAuth callback, `oauth.v2.access` response (discriminated union on `ok`)
- `src/slack/client.ts` — `getSlackClient(workspaceId)` closure with `postMessage`; plaintext token lives only in the closure
- `src/slack/ids.ts` — command/subcommand constants
- `src/db/queries/workspaces.ts` — `upsertWorkspace`, `getWorkspaceById`, `getWorkspaceBySlackTeamId`, `getWorkspaceBotAccessToken` (only function returning plaintext tokens)
- `src/db/queries/users.ts` — `upsertUser`, `getUserBySlackUserId`
- `src/app/api/slack/install/route.ts` — mints state, redirects to `oauth/v2/authorize`
- `src/app/api/slack/oauth_callback/route.ts` — verifies state, exchanges code, upserts workspace + installer user
- `src/app/api/slack/commands/route.ts` — raw-body signature verification, Zod parse, inline `/confetti hello` handler
- `src/app/page.tsx` — minimal Add to Slack landing page
- Schema: added `slack_team_name` column to `workspaces` (migration `0001_clear_wiccan.sql`)
- `@electric-sql/pglite` added as devDep + `tests/db.ts` helper for in-memory Postgres tests
- 48 tests passing across 6 files
- **Commit `c64b4c7`** pushed

**Decisions made today**
- **`chat:write.public` removed from manifest** — user wanted the bot scoped to one private channel rather than able to post in any public channel. Bot now posts only where it's been explicitly invited. ARCHITECTURE.md updated to match.
- **`slack_team_name` cached on `workspaces`** (b1 over b2) — populated at install from `oauth.v2.access`, refreshed on reinstall. No auto-refresh job. Trade-off accepted: workspace renames are rare; saves one Slack API call per `/confetti hello` and any future audit/admin view.
- **pglite for tests** (a over b/c/d) — adds ~7MB devDep but lets us hit real Postgres-compatible behavior in unit tests without integration test infrastructure
- **No `@slack/bolt`** — plain `fetch` for Slack API calls in `src/slack/client.ts`
- **`/confetti hello` handler lives inline in the route**, not in `src/slack/handlers/commands.ts`. Will lift out when Week 3/4 adds real subcommands (setup, channel, budget, opt-outs).
- **Both idempotency checks dropped** — the unit test in `tests/workspaces.test.ts` AND the manual reinstall step in the smoke test. DB's `UNIQUE (slack_team_id)` constraint already enforces data integrity. The dropped checks would only catch future regressions of `ON CONFLICT DO UPDATE` (which would 500 reinstalls, not silently duplicate). User accepted the small detection-lag risk.
- 3-checkpoint cadence again: pure logic + queries → routes wired → smoke + commit

**Manifest URL substitution**
- `slack-manifest.yaml` uses literal `${APP_BASE_URL}` placeholders. User substitutes before pasting at api.slack.com.
- Current tunnel: `https://might-knife-scoring-connectivity.trycloudflare.com  ` (Cloudflare tunnel → localhost:3000)
- After any manifest scope change, the bot must be reinstalled in Slack for new scopes to take effect.

---

### Session 3 — Roster CSV upload + daily-scan event detection (Week 2)

**Goal achieved:** End-to-end smoke green. Uploaded a 3-person CSV via the gated `/upload` page (inserted 3, updated 0); flipped one person to `opted_out=true` in Drizzle Studio; ran `pnpm scan` and got exactly 2 events (birthday at +7, anniversary at +14 with `years=3`); re-ran scan and stayed at 2 events; re-uploaded CSV and got "inserted 0, updated 3" with opt-out preserved.

**What landed**
- `src/lib/dates.ts` — pure timezone-aware helpers: `nowInWorkspaceTz`, `todayInWorkspaceTz`, `birthdayThisYear`, `anniversaryThisYear`, `daysUntil`. DST-safe via UTC-midnight subtraction. Feb 29 → Feb 28 in non-leap years (commented in file header)
- `src/lib/csv.ts` — papaparse + Zod row schema; all-or-nothing on row errors (`Result.ok({rows: [], errors})`), hard `err` only for structural failures (missing required column, papaparse fault). Headers trimmed/lowercased; duplicate emails flag every offending row
- `src/lib/upload-cookie.ts` — HMAC-signed `confetti_ws` cookie (7-day expiry); same wire format as `state.ts`, reuses `SLACK_STATE_SECRET`
- `src/db/queries/people.ts` — `upsertPeople` with `xmax = 0` trick to split insert/update counts; preserves `opted_out` and `slack_user_id` across re-uploads. `findBirthdayCandidates` + `findAnniversaryCandidates` filter `opted_out = false` AND `start_date < today` at the query layer (Architecture invariant #8)
- `src/db/queries/events.ts` — `findOrCreateEvents`: bulk `INSERT ... ON CONFLICT DO NOTHING RETURNING` returns only newly-inserted rows (Postgres semantics)
- `src/db/queries/workspaces.ts` — added `listAllWorkspaces` for the scan loop
- `src/jobs/daily-scan.ts` — split into pure `runDailyScan({db, log?, todayFor?})` (testable) and Inngest wrapper. Triggers: cron `0 14 * * *` daily AND event `confetti/scan.manual`
- `src/app/upload/{page,upload-form,actions}.tsx` — server component cookie gate, `useActionState` client form, server action with discriminated `ActionResult` union
- `src/app/api/slack/oauth_callback/route.ts` — sets `confetti_ws` cookie on successful install; success page now has "Upload your team CSV →" button
- `src/app/api/inngest/route.ts` — registered `dailyScan` alongside placeholder
- `scripts/scan.ts` + `pnpm scan` — POSTs `confetti/scan.manual` to local Inngest dev server (`http://localhost:8288/e/dev`, override via `INNGEST_DEV_URL`)
- Deps: `papaparse` + `@types/papaparse`, `date-fns`, `date-fns-tz`, `tsx` (devDep)
- 44 new tests (92 total: dates 19, csv 11, people-queries 7, daily-scan 7)
- **Commit `854483d`** pushed

**Decisions made today**
- **Manual trigger = `pnpm scan` script** (option a), not a `/dev` page (option b) — fewer permanent surfaces; a script is throwaway-by-context and won't ship to prod by accident
- **`xmax = 0` trick for upsert counts** — Postgres exposes this in `RETURNING`; lets `upsertPeople` distinguish fresh inserts (`xmax = 0`) from `ON CONFLICT DO UPDATE` hits (`xmax != 0`) in a single statement. Verified working in pglite
- **`upsertPeople` preserves `opted_out` + `slack_user_id` across re-uploads** — CSV is treated as source of truth for `name/birthday/start_date/team/role` only. So the Slack-roster matching that lands in Session 4 won't get clobbered, and admin-set opt-outs survive re-uploads
- **All-or-nothing CSV semantics** — any row-level error → return `ok({rows: [], errors})` so the UI can show "fix these N rows" with no partial commit. Idempotent re-upload is the fix flow
- **Pure / Inngest split in `daily-scan.ts`** — `runDailyScan({db, log, todayFor})` is fully testable with pglite + injected today; the Inngest function is a thin wrapper that calls it. No Inngest mocking required in tests
- **`secure: env.NODE_ENV === 'production'` on the cookie** — keeps dev working over the Cloudflare tunnel (HTTPS but `NODE_ENV=development`); browsers accept non-Secure cookies on HTTPS pages
- **Did NOT extract a shared HMAC sign/verify helper** — `upload-cookie.ts` duplicates ~70 lines from `state.ts`, but the modules differ in payload shape and expiry. Two callers don't justify the abstraction; refactor when a third lands
- **No `birthdayThisYear` / `daysUntil` use inside `daily-scan.ts`** — the scan uses calendar arithmetic via a private `addDays` helper. The public dates helpers are still tested for correctness as future utility (e.g. day-of post scheduling in Session 4)
- 3-checkpoint cadence held: pure logic + queries → routes + jobs → smoke + commit

**Smoke fixture (for future re-runs)**
A 3-person CSV named `roster.csv` was created in the repo root for the smoke test (untracked):
```
name,email,birthday,start_date
You,you@example.com,05-19,
You Anniversary,anniv@example.com,,2023-05-26
Opt Outter,opt@example.com,05-19,
```
Dates are pinned to today (2026-05-12) — birthday at today+7, anniversary at today+14 (3 years out). For Session 4 smoke, regenerate with the new "today" before re-running.

---

## Forward-looking notes (do before they bite)

- **Agent voice + behavior lives in `src/agent/prompt.ts`.** Tune there; don't sneak workspace-specific tone into other files. Voice is currently calibrated against a generic team — adjust per design partner if the next workspace wants it more formal/casual.
- **`logs/agent-YYYY-MM-DD.jsonl`** is the canonical instrument for judging agent quality. Read full lines (not just summaries) when iterating the prompt — the `tool_calls` arrays show *why* the model proposed what it did. Logs are gitignored. JSONL writes are synchronous in dev (concurrent appends race on macOS for >512B payloads).
- **`AGENT_MODEL` and timeout/cap constants live in `src/agent/model.ts`.** One file to change to swap models or tune the loop. Currently `claude-sonnet-4-6`, 30s timeout, 5-round cap.
- **The `propose_suggestions` defensive unwrap** in `src/agent/index.ts` handles the model's intermittent habit of double-encoding the suggestions array as a JSON string. Don't remove it — observed 1/10 in CP3 tuning, will recur in production.
- **`get_person_profile` calls Slack `users.info` if a `slackClient` is wired.** Failure is logged and degrades to DB-only — never breaks suggestion generation. When the `slack_user_id` column on `people` finally gets matched from CSV emails (deferred — see session 4 notes), this enrichment activates automatically.
- **`list_recent_workspace_gestures` reads from `approvals` + `events` + `suggestions`.** Only approved or modified gestures (skipped ones are excluded). New design partners with zero history get an empty list — the agent handles that fine. The query is in `src/db/queries/approvals.ts:listRecentApprovedGestures`.
- **Run `pnpm db:migrate` after pulling new migrations.** Day-of-session-4 was burned by a `42703` (`undefined_column`) error because `0002_stale_rockslide.sql` had been generated but not applied to Supabase. Make this a pre-session ritual: `git pull && pnpm db:migrate`.
- **Slack API gotchas to remember when wiring new methods (none active today, but bite hard):**
  - `views.open` requires `view` as a JSON-encoded *string* even when posting JSON (see `src/slack/client.ts:viewsOpen`)
  - `number_input.initial_value` rejects trailing zeros (`"50.00"` → `invalid_arguments`); use `Number().toString()`
  - `conversations.info` rejects JSON body — must be GET with query string (see `callGet` in client)
  - When a Slack call fails with `invalid_arguments`, the specific field is in `response_metadata.messages` — already plumbed through `callJson`'s warn log
- **`confetti_ws` cookie is bound to whatever host serves the OAuth callback.** Today that's `confetti-dev.anantsomani.com`. The named tunnel is permanent so this no longer bites mid-session — but when we transition to Vercel in Week 4, every workspace's cookie becomes useless and admins need to re-install.
- **Slack public distribution submission** is a Week 4 task (per ARCHITECTURE.md locked decisions). Submit early in the week to give Slack a few days for review.
- **Cloudflare tunnel → Vercel transition**: `APP_BASE_URL` is currently `https://confetti-dev.anantsomani.com`. When we deploy to Vercel in Week 4, update `APP_BASE_URL` in production env, re-upload manifest with the Vercel URL, and reinstall the bot. Local dev keeps using the named tunnel.
- **Profound (or backup) design partner**: still TBD per locked decisions. Plan says don't build v1 without a named target workspace.
- **`roster.csv` is untracked but lives in the repo root.** Like `sessions.md` it's a workspace-local artifact. If we want git to ignore it permanently, add it to `.gitignore` next session.
- **`vitest.config.ts` has `testTimeout: 30000`** to accommodate pglite cold-start. If individual tests start running for tens of seconds, that's a smell, not the timeout doing its job — investigate the test.
- **`ngrok.yml`** briefly appeared at repo root in Session 2 and was deleted by the user — flagging so it doesn't reappear as a surprise.

---

## Open / unfinished

**Session 5 wrap status:**
- Agent code + JSONL logging + tests landed and committed (`45cae21`, pushed to `origin/main`). 191/191 green, typecheck clean, biome clean.
- Three tuning runs completed (~30 events, ~$0.50 API spend). Voice + variety + budget compliance all on target.
- **E2E smoke (Steps 7–11 of session-4 walkthrough)** intentionally deferred to user when ready: tap Approve on any of the live DMs → manually fire `confetti/day-of.scheduled` in Inngest UI with the event ID → verify celebration post + thread + admin spend DM in `#sandbox` → reply with a number → see "Logged $X" → re-fire same day-of event → idempotency guard fires. The agent's involvement ends at the DM; downstream plumbing is unchanged from session 4, so re-smoke is a sanity check, not a discovery exercise.

**Session 6 scope (Week 4, Part B — ship):**
1. `/confetti setup` modal wizard for first-time admins (channel + budget picker)
2. `app_uninstalled` event: decide soft-mark vs hard-cascade and implement (currently logs only)
3. CSV → Slack roster matching: enrich `people.slack_user_id` by emailing `users.lookupByEmail`. Unlocks the agent's `get_person_profile` Slack enrichment automatically
4. 1-page install guide for non-engineer admins
5. Submit for Slack public distribution (allow a few days for review)
6. Deploy to Vercel; switch `APP_BASE_URL` to the Vercel URL in prod env; manifest URLs updated
7. Install in 1 external workspace as the first design partner
8. (Optional polish) Web search tool for the agent — currently noted as v2

**Pre-Session-6 to-do (do before opening Claude):**
1. Bring the tunnel up: `cloudflared tunnel run confetti-dev`
2. `pnpm dev` + `npx inngest-cli@latest dev` running
3. `git pull && pnpm db:migrate`
4. Decide on the first external design partner (Gaucho, per CP3 prompt; or backup per ARCHITECTURE.md locked decisions)
5. If re-running the agent tuning loop: `roster.csv` is the corpus. Either change emails to force fresh events or wipe test events in Drizzle Studio before re-scanning.
