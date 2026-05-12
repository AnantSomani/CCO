# CONVENTIONS.md — Confetti v1

> Coding rules and patterns. Read in full at the start of every session along with `PROJECT.md` and `ARCHITECTURE.md`. If a prompt asks you to violate one of these, ask first.

---

## TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`. No exceptions.
- No `any`. Use `unknown` and narrow.
- Prefer `type` for data, `interface` only for things that need to be extended.
- Discriminated unions over boolean flags. Example: `{ kind: 'pending' } | { kind: 'approved', approvedBy: string }`.
- Never use opaque `Record<string, unknown>` objects or string literal unions when a discriminated union would do.

## Errors

- No thrown exceptions across server boundaries (handlers, jobs, agent tools).
- Use a `Result<T, E>` type from `src/lib/result.ts`:
  ```ts
  type Result<T, E = string> =
    | { ok: true; value: T }
    | { ok: false; error: E };
  ```
- Throwing is fine inside a pure function as long as the caller catches at the boundary.
- Every handler logs the full error with context before returning to the caller.

## Validation

- All Slack payloads are parsed through a Zod schema before any business logic.
- CSV rows are Zod-validated per row; bad rows are reported back, not silently dropped.
- Agent tool inputs are Zod-validated; if the agent passes garbage, retry once with the parse error appended to the prompt.

## Database access

- All queries live in `src/db/queries/*`. No inline Drizzle in handlers or jobs.
- Query functions take typed inputs and return typed outputs. No leaking Drizzle types past the query layer.
- Use transactions when writing more than one row that must succeed together (e.g., event + suggestions).
- Soft delete is not used in v1. Hard delete with cascade.

## Slack

- All Block Kit construction lives in `src/slack/blocks/*`. Handlers compose blocks; they do not build them inline.
- All Slack API calls go through a single `getSlackClient(workspaceId)` that loads and decrypts the token.
- Never `console.log` a token, even partially.
- Action IDs and callback IDs are constants from `src/slack/ids.ts`. Never use string literals in handlers.

## Agent

- The system prompt is a single exported string in `src/agent/prompt.ts`. It is the only place voice and taste are defined.
- Tools are defined once in `src/agent/tools.ts` with both the Anthropic schema and the Zod parser side by side.
- The agent loop has a hard cap of 5 tool-call rounds. If it doesn't call `propose_suggestions` by round 4, force it on round 5 by removing other tools.
- Log every agent invocation with input, tool calls, and final output to a JSONL file (or a structured logger) for review.

## Jobs (Inngest)

- One job per file in `src/jobs/`.
- Job functions are pure: input → effects. Side effects only via injected clients.
- Every job has a "manual trigger" event in dev for testing without waiting for the cron.
- Steps within a job use `step.run` so retries don't re-do completed work.

## Time and dates

- Use `date-fns` and `date-fns-tz`. No `moment`. No raw `Date` arithmetic.
- All "is this today?" checks go through `src/lib/dates.ts` and take a timezone explicitly.
- Storing dates: `timestamptz` for moments in time, `date` for calendar dates with no time component (birthdays, anniversaries).

## Naming

- Files: `kebab-case.ts`.
- Variables and functions: `camelCase`.
- Types and components: `PascalCase`.
- Constants: `SCREAMING_SNAKE_CASE` only for true compile-time constants.
- Database tables: `snake_case`, plural.
- Database columns: `snake_case`.

## Commits

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`.
- One logical change per commit. Don't mix refactors with features.
- Reference the build week in the body when relevant: `(week 2)`.

## Tests

- Vitest. Tests live in `tests/` mirroring `src/` structure.
- Required test coverage in v1:
  - `src/lib/dates.ts` — every helper, including DST edge cases
  - `src/lib/csv.ts` — happy path + every validation error
  - `src/agent/tools.ts` — schema validation, retry on bad input
  - `src/slack/handlers/*` — every action, with mocked Slack client
  - `src/jobs/daily-scan.ts` — dedup, opt-out filtering, timezone correctness
- No tests for: Block Kit rendering, Inngest plumbing, OAuth callback.
- Mock the Slack client at the `getSlackClient` boundary. Do not mock Bolt itself.

## What NOT to do

- Do not add a frontend framework (React Router, tRPC, shadcn) without updating `ARCHITECTURE.md`.
- Do not add a queue, Redis, or caching layer in v1. Inngest is enough.
- Do not introduce a second LLM provider.
- Do not write a custom auth system. Slack OAuth is the only auth.
- Do not add features the plan has no need for.
- Do not write helpers that wrap other helpers that wrap Drizzle. One layer is enough.
- Do not create files "for future use." If it's not used now, it doesn't exist yet.

---

## Working with Claude Code on this project

### Session protocol

At the start of every Claude Code session, paste or reference:

```
Read PROJECT.md, ARCHITECTURE.md, and CONVENTIONS.md before doing anything.
We are in Week N working on: <one-line goal>.
Before writing code, outline the files you will touch and the approach.
Wait for my approval before writing code.
```

### Prompt patterns that work

**For scaffolding:**
> "Following ARCHITECTURE.md exactly, scaffold the file tree under src/ for Week 1. Create empty files with a one-line comment describing each file's purpose. Do not write logic yet. Show the tree first."

**For a feature:**
> "Implement [feature] for Week N task M. Touch only the files listed in ARCHITECTURE.md for this concern. Follow CONVENTIONS.md. Write the Zod schema first, then the function, then the test. Stop after each step and show me."

**For debugging:**
> "Here is the error: [paste]. Before changing code, explain in 3-5 sentences what you think is happening and what you would change. Do not write code yet."

**For review:**
> "Review the diff against CONVENTIONS.md. List violations with file:line. Do not auto-fix."

### Prompt patterns to avoid

- "Build the whole thing." → It will, badly.
- "Make it better." → No target. Be specific about what better means.
- "Add tests." → Say which tests, for which behaviors.
- "Just make it work." → It will, by deleting your invariants.

### When the AI proposes something off-plan

The right response is: *"That's not in PROJECT.md scope. Either justify why it belongs in v1, or skip it."* Be willing to update the doc if the justification is good. Do not let the doc and the code drift apart.

### Vertical slices, not horizontal layers

Build one full path through the system before building the next. By end of week 2 you should have a working detection job, not all the database queries you'll ever need. By end of week 3 you should have a working approval flow, not all the Block Kit components you'll ever need.
