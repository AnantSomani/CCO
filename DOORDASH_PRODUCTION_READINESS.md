# DoorDash Integration: Current State and Production Readiness

Last updated: August 22, 2026

## Executive summary

Confetti currently has a preview-only DoorDash integration designed for local development. It can
search restaurants, retrieve menus, propose exact items, require Slack approval, create a DoorDash
cart, and retrieve a live quote. It deliberately cannot submit an order or charge a payment method.

The installed DoorDash CLI is now v0.2.3. This release fixes the macOS startup problem encountered
with v0.2.2 and adds the headless `DD_CLI_ACCESS_TOKEN` authentication path needed by cloud hosts
such as Railway.

The integration is still not production-ready. Phase 0 contract work now unwraps and validates
`structuredContent`, accepts observed nullable and numeric v0.2.3 fields, supplies required intent
metadata to cart listing, and maps failures to stable support codes. Live read-only validation now
passes for address listing, restaurant search, menu retrieval, and cart listing. The remaining
Phase 0 release gate is a controlled cart-addition and quote preview through Confetti's normal Slack
approval flow.

The Slack agent also has no cross-message conversation state. Each `/confetti` command is an
independent run, and direct-message replies are handled by the birthday/spend handler rather than
continued by the admin agent. This causes Confetti to repeatedly ask for details the user already
provided.

Recommended approach:

1. Make the local preview flow correct and deterministic.
2. Deploy a controlled, single-DoorDash-account preview on Railway.
3. Add per-workspace credentials and stronger isolation before enabling multiple customers.
4. Keep real order submission out of scope until it has a separate approval and safety design.

## Scope and safety boundary

The current and recommended first production scope is **preview only**:

- Search restaurants and menus.
- Resolve exact item and customization identifiers.
- Require an authorized Slack admin to approve cart creation.
- Add approved items to a DoorDash cart.
- Retrieve and display the live quote, fees, credits, delivery information, work benefits, and
  PIN-handoff requirements.
- Never call `order submit`.
- Never charge a card, wallet, work benefit, or other payment method.

The dd-cli wrapper blocks both `submit` and `checkout-url` command arguments. Real order submission
must remain a separate future feature with a second approval immediately before charging.

## Verified environment state

### DoorDash CLI

- Installed binary: `~/.local/bin/dd-cli`
- Installed version: `0.2.3`
- Local platform: Apple Silicon macOS (`darwin-arm64`)
- Desktop login: working through `dd-cli login`
- Desktop credentials: stored in the macOS Keychain
- Headless token command: `dd-cli export-token`
- Headless environment variable: `DD_CLI_ACCESS_TOKEN`
- Linux production artifact: `dd-cli-v0.2.3-linux-amd64.tar.gz`

`DD_CLI_ACCESS_TOKEN` is treated like a password. It must only be stored in a secrets manager.
It must never be committed, logged, placed in Slack, pasted into tickets, or stored in a checked-in
environment file.

Desktop keychain sessions can refresh automatically in v0.2.3. Headless access tokens do not store
refresh tokens, so production needs an explicit rotation procedure when a token expires.

### Repository state

The DoorDash implementation currently exists as uncommitted work in this repository. Before any
deployment, review the complete diff, rerun all checks, and commit it on an appropriate branch.

Important implementation files:

- `src/integrations/doordash/dd-cli-client.ts`
- `src/agent/admin-agent.ts`
- `src/agent/command-types.ts`
- `src/jobs/agent-command.ts`
- `src/jobs/execute-agent-action.ts`
- `src/slack/blocks/agent-action.ts`
- `src/slack/handlers/messages.ts`
- `src/lib/env.ts`
- `scripts/dev-stack.sh`

Important test files:

- `tests/dd-cli-client.test.ts`
- `tests/admin-agent.test.ts`
- `tests/execute-agent-action.test.ts`
- `tests/agent-action-blocks.test.ts`
- `tests/env.test.ts`

## Current end-to-end flow

### 1. Slack command

An authorized workspace admin sends a natural-language `/confetti` command. Static commands such
as `hello`, `help`, `channel`, and `budget` are handled synchronously. Other commands create an
`agent_runs` row and emit `confetti/agent-command.requested` to Inngest.

### 2. Admin agent discovery

The `agent-command` Inngest function runs the admin agent. When
`DOORDASH_EXECUTOR=dd-cli`, the agent receives DoorDash tools that can:

- Read the DoorDash account's saved default address.
- Search nearby restaurants.
- Retrieve a restaurant menu.
- Propose a `doordash_order_preview` action using exact identifiers returned during that run.

Discovery results currently exist only in memory during one agent run. They are lost when the run
ends.

### 3. Slack approval

The proposed action is persisted in `agent_actions` with `pending_confirmation` status. Confetti
sends an approval card to the admin. The card explains that approval may create or modify a
DoorDash cart but cannot submit or charge an order.

### 4. Approved execution

After approval, Confetti emits `confetti/agent-action.approved`. The `execute-agent-action`
Inngest function:

1. Atomically changes the action from `approved` to `executing`.
2. Checks the workspace estimate against its configured event budget.
3. Refuses to append to an unexpected existing cart at the selected store.
4. Adds the approved items to a new DoorDash cart.
5. Calls `order preview --include-work-benefits`.
6. Stores the quote in `agent_actions.execution_result`.
7. Updates the Slack approval message with the result.

### 5. Explicitly absent behavior

The current integration has no supported path for:

- Submitting an order.
- Charging a payment method.
- Selecting a different payment method.
- Cancelling or deleting a DoorDash cart through Confetti.
- Continuing an existing preview from a later Slack message.
- Managing separate DoorDash credentials for separate Confetti workspaces.

## Confirmed defects and resolutions

### 1. Resolved: dd-cli JSON envelope was parsed incorrectly

Live dd-cli v0.2.3 calls were inspected without printing personal field values. Both commands
returned a transport envelope:

```text
address list root:
  content
  isError
  structuredContent

search root:
  content
  isError
  structuredContent
```

The useful fields are nested:

```text
structuredContent.addresses
structuredContent.stores
```

The original implementation expected:

```text
addresses
stores
```

As a result, the original Zod parser returned `dd_cli_unexpected_response` even though dd-cli
completed successfully.

Implemented resolution:

- Added a validated transport-envelope schema.
- Rejects `isError=true` with deterministic authentication or command error codes.
- Parses each command's payload from `structuredContent`.
- Ignores `widget_type`, `assistant_instructions`, and other terminal-inapplicable UI instructions.
- Accepts observed nullable address fields and numeric menu prices.
- Supplies the required `--intent` argument to `cart list`.
- Uses sanitized v0.2.3 response fixtures in contract tests.
- Logs only sanitized command name, duration, exit code, error code, and schema-error path.

### 2. No conversation continuity

Each `/confetti` command creates a new, independent agent run containing only the current command's
text. Previous requests, answers, tool results, and requested fields are not supplied to the next
run.

Direct messages do not continue the admin agent. `src/slack/handlers/messages.ts` currently handles:

- Birthday opt-in and opt-out.
- Spend logging.
- Generic help.

Therefore a user who replies to an agent question with an address or delivery time receives the
generic birthday help message, and a later slash command starts over.

Required fix:

- Introduce a persisted admin conversation or order-draft record scoped by workspace and Slack user.
- Store structured slots instead of relying on prose history:
  - Address and resolved coordinates/place identifier.
  - Delivery date, time, and timezone.
  - Restaurant selection.
  - Exact menu items and quantities.
  - Required customizations.
  - Maximum approved estimate.
  - Draft status and expiration.
- Route eligible admin DMs or thread replies into the active draft.
- Include only the relevant bounded history in model calls.
- Add explicit commands to cancel or restart a draft.

### 3. Supplied addresses are ignored

The current search tool always reads the DoorDash account's default saved address and uses its
coordinates. A street address typed into Slack is not passed to dd-cli.

This caused the model to provide a false explanation that DoorDash could not recognize the user's
address. The address was never sent to DoorDash.

dd-cli v0.2.3 now provides:

- `address find --query "<address>"`
- `address add --place-id <id>`

Recommended behavior:

- Use `address find` to resolve a user-supplied address.
- Show candidates when resolution is ambiguous.
- Do not silently call `address add`, because it mutates the DoorDash account's default address.
- If saving or changing the default address is required, represent it as a separately approved
  action.
- Prefer searching with resolved coordinates without changing account state when dd-cli supports
  that path.

### 4. Mitigated: agent invented explanations for tool failures

The model receives normalized errors but is currently free to infer causes. It attributed
`dd_cli_unexpected_response` to address formatting even though the failure was a local parser
mismatch.

Implemented mitigation:

- Known integration errors map to deterministic, user-safe text outside the model.
- Tool errors explicitly prohibit inferring another cause or blaming user input.
- Slack-facing model context includes stable `DD-AUTH`, `DD-CONTRACT`, `DD-TIMEOUT`, `DD-OUTPUT`,
  `DD-COMMAND`, or `DD-EXECUTOR` support codes.
- Logs include sanitized command name, duration, exit code, error code, and schema-error location.

The model remains responsible for composing the final response, so continued regression testing is
required; deterministic tool text substantially reduces but does not mathematically eliminate
model noncompliance.

### 5. Resolved: acknowledgement text was stale

Food-related requests now receive executor-aware acknowledgement text. Sandbox mode describes a
sandbox order. DoorDash mode describes live DoorDash discovery, states that preview safety rules
apply, and explicitly says no order will be submitted.

## Reliability and safety gaps

### Orphan carts

If `cart add-items` succeeds but previewing or persistence fails, DoorDash may retain an open cart.
A retry then encounters the existing-cart guard and fails. Confetti currently has no cleanup or
resume path.

Required fix:

- Persist the cart UUID immediately after cart creation.
- Resume previewing the same cart on retry.
- Add an explicit approved cleanup action or safe compensating `cart delete` behavior.
- Never automatically delete a pre-existing cart that Confetti did not create.

### Retry state

Failed or interrupted actions can produce confusing Inngest retries:

- An action can be left in `executing`.
- A retry can encounter a cart created by the previous attempt.
- `execute-agent-action` lacks a complete terminal failure handler.

Required fix:

- Define a durable state machine for discovery, cart creation, previewing, completion, and cleanup.
- Make each external side effect idempotent.
- Store operation and cart identifiers before the next network operation.
- Add recovery for stale `executing` actions.
- Add an Inngest `onFailure` handler that produces an actionable Slack message.

### Estimate versus live total

The workspace budget is checked against the user/model estimate before cart creation. The live
DoorDash total can exceed that estimate due to fees, taxes, or pricing changes.

Required fix:

- Treat the user's amount as a maximum, not merely an estimate.
- Compare the authoritative preview total against the workspace budget and approved maximum.
- If the quote exceeds either limit, do not mark the action successful.
- Show the quote and ask the admin to revise the cart or explicitly approve a higher maximum.

### Menu and customization handling

- Agent-visible menus are truncated to 100 items.
- Nested option validation checks identifier presence but does not fully validate option structure,
  minimums, maximums, or incompatible combinations.
- Partial `item_errors` are collapsed into a generic failure.

Required fix:

- Add menu search/filtering or pagination.
- Use `restaurant-item-details` when an item has required options.
- Validate customization groups structurally.
- Surface safe, specific item errors and ask focused follow-up questions.

## Authentication and secret management

### Local development

Local development uses:

```text
dd-cli login
```

v0.2.3 stores desktop credentials in the macOS Keychain and refreshes the access token
automatically.

### Headless production

Headless production uses:

```text
DD_CLI_ACCESS_TOKEN
```

Generate it on a trusted browser-equipped computer:

```text
dd-cli export-token
```

Production requirements:

- Store the token as a sealed Railway secret.
- Never write it to logs or the database unless per-tenant encrypted storage is intentionally
  implemented.
- Add startup and periodic read-only health checks.
- Alert on `dd_cli_auth_required`.
- Document token rotation and emergency revocation.
- Rotate without exposing the token in shell history, CI logs, or deployment output.

The app currently inherits process environment variables when invoking dd-cli, so a globally set
`DD_CLI_ACCESS_TOKEN` will reach the subprocess. The repository does not currently validate or
document that token.

## Deployment options

### Option A: Run the complete app on Railway

This is the fastest path for a controlled single-DoorDash-account preview.

Build a Linux container that includes:

- The Confetti Next.js application.
- Node.js and production dependencies.
- dd-cli v0.2.3 `linux-amd64`.
- The dd-cli archive checksum verification during the image build.

Configure Railway with:

- Existing Confetti production environment variables.
- `DOORDASH_EXECUTOR=dd-cli`
- Sealed `DD_CLI_ACCESS_TOKEN`
- A stable public domain for Slack and Inngest callbacks.

Advantages:

- Discovery and approved execution can use the existing local dd-cli client without a new network
  boundary.
- No OS keychain or persistent volume is required for authentication.
- The database remains on Supabase.

Tradeoffs:

- Moves the Next.js runtime from Vercel to Railway.
- One process environment provides one DoorDash account.
- Scaling replicas with one shared DoorDash account increases cart concurrency risks.
- Token rotation restarts or redeploys the service unless the platform supports seamless secret
  replacement.

### Option B: Keep Vercel and add a Railway DoorDash worker

This preserves the existing app deployment but requires additional engineering.

Vercel continues to handle:

- Slack routes and OAuth.
- The web dashboard.
- Admin-agent orchestration.
- Database writes and approval UX.

Railway handles:

- dd-cli discovery calls.
- Approved cart creation and preview.
- Token access.

Required new components:

- An authenticated internal worker API for synchronous search and menu calls.
- A durable execution queue or worker-side Inngest function for approved mutations.
- Signed requests, replay protection, strict command schemas, and request idempotency.
- Worker health checks and observability.

Advantages:

- Keeps the existing Vercel deployment.
- Isolates dd-cli and its credentials.
- Provides a cleaner future boundary for per-tenant workers.

Tradeoffs:

- More services, networking, failure modes, and operational work.
- Discovery is synchronous from the agent's perspective and must meet agent timeout limits.

### Recommended initial deployment

For a private beta using one controlled DoorDash account, use Option A after fixing the local
contract and agent-state issues. It is materially simpler and validates customer value sooner.

Do not represent a globally shared DoorDash account as multi-tenant production.

## Multi-customer requirements

A single Railway environment variable represents one DoorDash account. If multiple Confetti
workspaces share it, they also share:

- Saved addresses.
- Open carts.
- Order history.
- Credits and work benefits.
- Payment context.
- Authentication expiry and outages.

That is not acceptable tenant isolation.

Before enabling multiple customer workspaces, implement:

- A one-to-one mapping from Confetti workspace to DoorDash credential.
- Encrypted credential storage using envelope encryption and a managed KMS.
- Strict workspace authorization before credential retrieval.
- Per-subprocess environment injection so each dd-cli call receives only the selected workspace's
  token.
- No global `DD_CLI_ACCESS_TOKEN` in a multi-tenant worker.
- Token rotation, disconnect, and deletion workflows.
- Audit records for credential use without logging credential values.
- Concurrency controls per DoorDash account.
- A customer onboarding process for generating and securely supplying a token.

Important product limitation: `dd-cli export-token` requires the customer to use a CLI and browser,
and headless tokens do not refresh automatically. This is technically workable for a small,
high-touch beta but is poor self-service SaaS onboarding. An official DoorDash OAuth/partner flow
would still be preferable for broad production use.

## Data and privacy review

Before production:

- Review the complete `structuredContent` payloads returned by dd-cli.
- Define an allowlist of fields stored in `execution_result`; do not store the full quote envelope
  by default.
- Redact addresses, account identifiers, payment hints, trace IDs, and other sensitive values from
  logs.
- Confirm whether the 90-day agent audit retention period is appropriate for cart and delivery
  data.
- Add a workspace deletion/disconnect flow that removes DoorDash tokens and related draft data.
- Review DoorDash beta access terms and confirm the intended commercial, automated, and
  multi-customer use is permitted.

## Observability requirements

Add structured metrics and logs for:

- dd-cli command category, excluding arguments that contain addresses or item text.
- Command latency and timeout count.
- Exit-code and normalized-error counts.
- Authentication health and token-expiry failures.
- Search and menu schema-validation failures.
- Cart creation, preview completion, and orphan-cart recovery.
- Quote-over-budget events.
- Per-workspace concurrency and rate limits.

Add alerts for:

- Repeated `dd_cli_auth_required`.
- Increased `dd_cli_unexpected_response`.
- Actions stuck in `executing`.
- Repeated existing-cart conflicts.
- Railway worker unavailability.

## Testing required before production

### Contract tests

- Record sanitized v0.2.3 response fixtures for every used command.
- Validate the transport envelope and `structuredContent`.
- Test `isError=true`, missing `structuredContent`, malformed JSON, and incompatible schema changes.

### Agent tests

- User supplies fields across multiple messages.
- Direct-message and thread continuation.
- Ambiguous address, restaurant, item, date, and timezone.
- No repeated questions for already collected fields.
- No invented cause for tool failures.
- Draft cancel, restart, and expiration.

### Execution tests

- Existing user cart is never modified or deleted.
- Confetti-created cart resumes after a preview timeout.
- Partial item errors preserve successful and failed item details safely.
- Live total above the approved maximum.
- Work-benefit selection is never applied silently.
- PIN-handoff requirement is displayed.
- Duplicate approval and Inngest retry do not duplicate cart items.

### Deployment tests

- Linux dd-cli binary starts in the production image.
- Checksum verification fails the build on a mismatched binary.
- `DD_CLI_ACCESS_TOKEN` works without a keychain.
- Token values never appear in build or runtime logs.
- Slack acknowledgement remains within Slack's response deadline.
- Railway restarts and redeploys do not lose pending action state.

### Release checks

Run:

```text
pnpm check
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

Then complete a controlled live preview in a dedicated test DoorDash account and verify:

- No order appears in order history.
- No payment method is charged.
- The expected open cart exists.
- The Slack quote matches DoorDash.
- A retry does not duplicate items.

## Phased implementation plan

The phases are ordered dependency gates, not parallel workstreams. A phase starts only after the
previous phase's exit criteria pass. Two production milestones are intentionally different:

- **Controlled production preview:** complete Phases 0 through 3. This permits one dedicated
  DoorDash account and explicitly allowlisted Confetti workspaces.
- **Multi-customer production preview:** complete Phases 0 through 4. This permits independent
  customer credentials only after tenant isolation has been proven.
- **Real order submission:** Phase 5 is a separate future product and safety project. It is not
  part of preview production readiness.

### Phase 0: Repair and lock the dd-cli contract

**Status:** implementation and read-only live validation complete. One controlled cart-addition and
quote preview through the normal Slack approval flow remains before the Phase 0 gate is closed.

**Objective:** make the existing local preview integration correct, deterministic, and protected
against known dd-cli v0.2.3 response changes before building higher-level behavior on top of it.

**Implementation scope:**

1. Define and validate the dd-cli transport envelope, including `content`, `isError`, and
   `structuredContent`.
2. Parse command payloads from `structuredContent`; never validate command fields at the response
   root.
3. Map malformed JSON, CLI process failures, `isError=true`, missing payloads, authentication
   failures, and incompatible schemas to stable internal error codes.
4. Record sanitized v0.2.3 fixtures for every command Confetti uses:
   - `address list`
   - restaurant search
   - menu retrieval
   - cart listing
   - cart item addition
   - order preview
5. Use the real envelope shape in client contract tests while keeping higher layers behind the
   typed client boundary.
6. Replace the stale "sandbox order" acknowledgement with wording that accurately describes the
   enabled executor without promising a successful search.
7. Document how fixtures are sanitized and refreshed when the pinned dd-cli version changes.

**Validation:**

- Run client contract tests against every fixture and negative envelope case.
- Complete a local live search, menu lookup, cart creation, and quote using a dedicated test
  DoorDash account.
- Confirm tool or schema failures are reported as integration failures rather than blamed on user
  input.
- Confirm `submit` and `checkout-url` remain blocked.

**Exit criteria:**

- dd-cli v0.2.3 envelope parsing works for all used commands.
- Live search, menu retrieval, cart creation, and preview succeed locally.
- Tests use realistic sanitized v0.2.3 fixtures.
- Errors are deterministic, actionable, and do not expose credentials or raw sensitive payloads.
- Agent never attributes schema or infrastructure errors to user input.

### Phase 1: Persist deterministic order conversations

**Depends on:** Phase 0.

**Objective:** let an authorized admin provide order details naturally over multiple Slack
messages without losing context, repeating answered questions, or silently ignoring supplied
values.

**Implementation scope:**

1. Add a persisted DoorDash order-draft model and migration. At minimum, retain:
   - verified workspace and requesting admin
   - Slack channel, thread, and message correlation identifiers
   - supplied and resolved delivery address
   - requested date, time, and timezone
   - restaurant query and selected store
   - selected items, customizations, and quantities
   - approved maximum spend
   - draft status, expiration, and timestamps
2. Define an explicit draft state machine, such as `collecting`, `ready_for_proposal`,
   `pending_approval`, `approved`, `executing`, `completed`, `cancelled`, and `expired`.
3. Route eligible admin DM and thread replies to the active draft before the birthday/spend
   fallback handler.
4. Scope continuation by verified workspace, admin, and Slack conversation. Never continue
   another user's or workspace's draft.
5. Ask only for missing or ambiguous fields and clearly summarize resolved fields before
   proposing an action.
6. Implement cancel, restart, replacement, and expiration behavior, including handling multiple
   possible active drafts without guessing.
7. Use `address find` for a user-supplied address. If it cannot be resolved, say so; never search
   using the saved default while claiming the supplied address was used.
8. Store stable DoorDash identifiers only after they are returned by discovery; do not allow the
   model to invent store, item, or customization IDs.

**Validation:**

- Exercise one-shot commands, multi-message DMs, and thread continuation.
- Test ambiguous addresses, restaurants, items, times, and timezones.
- Test cancellation, expiration, concurrent drafts, unauthorized replies, and workspace
  isolation.
- Verify collected values survive process restarts and Inngest retries.

**Exit criteria:**

- Address, time, restaurant, items, quantities, and maximum are retained across messages.
- Admin DM and supported thread replies continue the correct active draft.
- Confetti asks only for missing or ambiguous fields.
- Supplied addresses are resolved honestly and deterministically.
- Drafts survive restarts, expire safely, and can be cancelled or restarted.
- Approval cards are generated from a persisted, immutable proposal snapshot.

### Phase 2: Make cart execution idempotent and recoverable

**Depends on:** Phase 1.

**Objective:** guarantee that approving or retrying a preview action creates at most one intended
cart mutation, enforces the approved limit, and leaves enough durable state for safe recovery.

**Implementation scope:**

1. Persist execution attempts and the Confetti-created cart UUID immediately after cart creation,
   before adding items or requesting a quote.
2. Define checkpointed execution steps so retries resume from durable state instead of repeating
   completed mutations.
3. Add explicit idempotency keys for approval, cart creation, item addition, and preview retrieval.
4. Preserve the existing rule that Confetti never modifies or deletes a pre-existing user cart.
5. Detect and classify partial item failures. Preserve safe successful/failed item details for
   operator review without blindly retrying the full batch.
6. Compare the authoritative live total against the approved maximum. If the total exceeds the
   limit, stop and request a new explicit approval; do not reinterpret the old approval.
7. Display fees, credits, delivery details, work-benefit effects, and PIN-handoff requirements
   without silently selecting benefits or payment behavior.
8. Add `execute-agent-action` failure handling that records the checkpoint and delivers a stable,
   safe Slack result.
9. Provide an operator recovery procedure for timed-out previews and orphaned
   Confetti-created carts. Recovery must not require editing production database rows by hand.

**Validation:**

- Replay duplicate Slack approvals and duplicate Inngest events.
- Inject failures before and after cart creation, item addition, and quote retrieval.
- Verify a retry never duplicates items.
- Verify an over-limit live quote cannot be presented as approved.
- Verify existing user carts remain untouched in every failure path.

**Exit criteria:**

- Cart UUID and execution checkpoints are persisted as work occurs.
- Duplicate approvals and retries resume safely and do not duplicate cart items.
- Orphaned Confetti-created carts can be identified and safely recovered.
- Live quote limits are enforced against the authoritative total.
- Partial failures and PIN/work-benefit requirements are represented accurately in Slack.
- Operators can recover failures using documented tooling and procedures.

### Phase 3: Run a controlled single-account production preview

**Depends on:** Phase 2 and an explicit deployment architecture decision.

**Objective:** run the hardened preview flow in production infrastructure with one dedicated
DoorDash test account, a small workspace allowlist, and no customer credential onboarding.

The fastest documented path is a full Railway deployment. If the application remains on Vercel,
build a separately authenticated Railway executor with a durable claim protocol; do not attempt to
spawn dd-cli from Vercel.

**Implementation scope:**

1. Build a reproducible Linux image that pins the Node.js and dd-cli versions and verifies the
   dd-cli artifact checksum during the build.
2. Authenticate through `DD_CLI_ACCESS_TOKEN` stored only in Railway's secrets manager.
3. Add startup checks for binary compatibility, token health, database access, and executor
   readiness.
4. Restrict DoorDash tools and execution to an explicit workspace allowlist independent of the
   general Slack admin check.
5. Implement and test a global DoorDash kill switch that stops new discovery and execution while
   leaving unrelated Confetti features available.
6. Emit structured, redacted logs and metrics for discovery, proposal, approval, cart mutation,
   preview, retry, failure category, latency, and token health.
7. Configure alerts for authentication failures, repeated contract failures, stuck executions,
   duplicate-prevention events, and elevated error rates.
8. Document deployment, token rotation, incident response, cart recovery, rollback, and removal of
   an allowlisted workspace.
9. Update `.env.example`, `DEV.md`, `PRODUCTION.md`, and `ARCHITECTURE.md` to match the selected
   production architecture.

**Validation:**

- Deploy to a production-like Railway environment from a clean checkout.
- Restart and redeploy during pending and executing actions.
- Rotate and revoke the headless token.
- Exercise the global kill switch and workspace allowlist.
- Complete controlled live previews and verify no order is submitted and no payment method is
  charged.
- Run release checks and review logs for secret or sensitive payload leakage.

**Exit criteria:**

- Production image pins and verifies a known-working Linux dd-cli build.
- Headless authentication, health checks, metrics, alerts, and token rotation work.
- Only explicitly allowlisted workspaces can access the dedicated test account.
- Restart, retry, incident, cart-recovery, rollback, and kill-switch procedures are tested.
- Security, privacy, and DoorDash beta-terms reviews approve the controlled scope.
- A sustained beta period completes without duplicate cart mutations, cross-workspace leakage,
  secret exposure, order submission, or charges.

Completing Phase 3 is **controlled production preview ready**, not general multi-customer ready.

### Phase 4: Add multi-tenant credential and data isolation

**Depends on:** a stable Phase 3 beta and approval to use independent customer DoorDash
credentials.

**Objective:** allow multiple Confetti customers to use preview functionality without sharing
credentials, addresses, carts, drafts, logs, or execution state.

**Implementation scope:**

1. Design a per-workspace DoorDash connection model with encrypted credentials, status, key
   version, token health, last rotation, and revocation metadata.
2. Keep encryption keys outside the database and support key rotation without exposing plaintext
   credentials to logs, Slack, analytics, or support tooling.
3. Select credentials only from verified Slack workspace identity and inject them into the single
   scoped subprocess invocation. Never place tenant credentials in process-global state.
4. Add secure admin-only connect, verify, rotate, disconnect, and delete workflows.
5. Scope every draft, action, cart checkpoint, audit row, metric, and recovery operation by
   workspace.
6. Add tenant-aware rate limits, concurrency controls, kill switches, and token-health isolation
   so one customer's failures cannot block or expose another customer.
7. Define retention and deletion behavior for credentials, addresses, DoorDash identifiers,
   quotes, execution results, and logs.
8. Complete customer-facing consent, privacy, support, and beta-terms documentation.

**Validation:**

- Run adversarial cross-tenant tests at every lookup and execution boundary.
- Attempt workspace-ID substitution, stale action replay, credential mix-up, concurrent execution,
  token revocation, disconnect, and deletion.
- Verify logs, alerts, operator tools, and recovery procedures cannot expose another tenant's
  identifiers or payloads.
- Run a staged beta with separate DoorDash accounts and workspaces.

**Exit criteria:**

- Each workspace has an independent encrypted DoorDash credential and lifecycle.
- Credentials are selected by verified workspace identity and scoped to one invocation.
- All persisted and observable DoorDash data is tenant-scoped.
- Cross-tenant tests prove credentials, addresses, drafts, carts, and results cannot leak.
- Token onboarding, rotation, revocation, disconnect, deletion, and customer offboarding work.
- Security, privacy, support, and DoorDash terms reviews approve the multi-customer scope.
- Multi-account staged beta and all production launch gates pass.

Completing Phase 4 is **multi-customer production preview ready**.

### Phase 5: Consider real order submission as a separate product

**Status:** explicitly out of scope for preview production readiness.

Do not enable submission by extending the preview action or relaxing the wrapper's command block.
If pursued later, begin with a new threat model, product specification, and launch review.

At minimum, require:

- A new action kind and separately permissioned executor capability.
- A fresh authoritative quote followed by a second explicit approval immediately before charge.
- Exact total, fees, credits, delivery details, payment method identity, work-benefit behavior, and
  PIN requirements shown at approval time.
- A short approval expiration and protection against changed prices, inventory, address, or
  delivery time.
- End-to-end idempotency, submit-result persistence, reconciliation, and post-submit status
  recovery.
- Cancellation, refund, substitution, failed-delivery, duplicate-charge, and customer-support
  procedures.
- Legal, financial, tax, privacy, fraud, abuse, accessibility, and DoorDash terms review.
- A separately staged launch with lower limits, stronger monitoring, and an immediate submission
  kill switch.

## Production launch gates

Do not enable the DoorDash preview feature in production until all of these are true:

- The `structuredContent` contract bug is fixed.
- Cross-message order drafts work.
- Supplied addresses are resolved honestly and deterministically.
- Live totals are checked against approved limits.
- Cart retries are idempotent and recoverable.
- A pinned Linux dd-cli binary is present in the production runtime.
- Headless token health and rotation are documented and tested.
- DoorDash access is restricted to an explicit workspace allowlist.
- Logs and stored payloads pass privacy review.
- Automated and controlled live tests pass.
- The global kill switch has been exercised.

For a multi-customer launch, also require:

- Per-workspace encrypted credentials.
- Proven tenant isolation.
- Customer token onboarding and revocation.
- Confirmation that the beta CLI access terms permit the intended use.

## Immediate next actions

1. Complete one controlled cart-addition and quote preview through Confetti's Slack approval flow;
   verify that no order is submitted and no payment method is charged.
2. Close Phase 0 after the controlled preview passes and commit the verified DoorDash scaffold and
   Phase 0 work as one coherent checkpoint.
3. Add persisted DoorDash order drafts and route admin DM replies to them.
4. Use `address find` for supplied addresses; never pretend an ignored address was searched.
5. Persist cart UUIDs and implement retry/resume behavior.
6. Enforce the approved maximum against the live quote.
7. Decide between:
   - moving the controlled beta app to Railway, or
   - keeping Vercel and building a Railway worker.
8. For the fastest controlled beta, create a pinned Railway Docker image and use one dedicated
   test DoorDash account.
9. Update `.env.example`, `DEV.md`, `PRODUCTION.md`, and `ARCHITECTURE.md` for v0.2.3 headless auth
   and the final deployment decision.
10. Complete security, privacy, and DoorDash beta-terms review before adding customer credentials.

## Definition of production-ready preview

The DoorDash preview integration is production-ready when an authorized admin can provide order
details naturally across multiple Slack messages, Confetti resolves those details without losing
context or inventing errors, an approved action creates exactly one recoverable cart, the live
quote respects the approved budget, no order can be submitted, credentials and data are isolated
per intended tenant scope, and operators can detect, rotate, disable, and recover the integration
without exposing secrets or editing production data manually.
