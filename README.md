# Confetti

Confetti is a Slack-native AI agent that quietly runs the joyful parts of a company's culture, starting with celebrating birthdays and work anniversaries. When a teammate's special day is approaching, Confetti DMs a workspace admin in Slack with 2–3 suggested gestures and an estimated budget; the admin approves with one tap; on the day, Confetti posts a celebration to a chosen channel and opens a "sign the card" thread.

## Planning docs

- [PROJECT.md](./PROJECT.md) — what Confetti is, v1 scope, definition of done, build sequence, risks
- [ARCHITECTURE.md](./ARCHITECTURE.md) — stack, repo layout, data model, agent loops, invariants, locked decisions
- [CONVENTIONS.md](./CONVENTIONS.md) — coding rules, patterns, and how to work with Claude Code on this repo

Read all three at the start of any non-trivial session.

## Local development

### Prerequisites

- Node.js 20+ (we test on 22)
- pnpm 10+
- A Supabase project (free tier is fine) — used only as Postgres
- `openssl` for generating the encryption key

### Setup from a fresh clone

```bash
# 1. Install dependencies
pnpm install

# 2. Generate a 32-byte token encryption key (copy the output)
openssl rand -base64 32

# 3. Create your local env file
cp .env.example .env.local
# Then edit .env.local:
#   - DATABASE_URL  → Supabase Transaction pooler URL (port 6543) with ?pgbouncer=true&connection_limit=1
#   - DIRECT_URL    → Supabase Direct connection URL  (port 5432)
#   - TOKEN_ENCRYPTION_KEY → paste the openssl output
#   - All other fields can stay as `placeholder` until you wire up Slack/Anthropic/Inngest

# 4. Apply the database schema to your Supabase project
pnpm db:migrate

# 5. Verify everything works
pnpm test          # all unit tests pass
pnpm dev           # Next.js dev server on http://localhost:3000
pnpm db:studio     # Drizzle Studio at https://local.drizzle.studio (browse your DB)

# 6. (Optional) start the Inngest dev UI in a separate terminal
npx inngest-cli@latest dev
# Dashboard at http://127.0.0.1:8288
```

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Start Next.js dev server (with Turbopack) |
| `pnpm build` | Production build |
| `pnpm start` | Run the production build |
| `pnpm test` | Run Vitest once |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm lint` | Lint with Biome |
| `pnpm format` | Format with Biome (writes changes) |
| `pnpm check` | Biome lint + format check (no writes) |
| `pnpm db:generate` | Generate a new Drizzle migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply pending migrations to the DB pointed at by `DIRECT_URL` |
| `pnpm db:studio` | Open Drizzle Studio in your browser |

### Project status

This repo is currently in **Week 1** (foundations). Slack OAuth, the slash command, the agent, and the approval flow ship in Sessions 2–4. See `PROJECT.md` for the full build sequence.
