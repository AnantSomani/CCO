import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// ─── workspaces ──────────────────────────────────────────────────────────────
// One row per Slack workspace that has installed the bot.
// `id` is our internal uuid; `slack_team_id` is the Slack team identifier and is
// the natural key OAuth callbacks upsert on.
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  slackTeamId: text('slack_team_id').notNull().unique(),
  slackTeamName: text('slack_team_name').notNull(),
  botAccessTokenEnc: text('bot_access_token_enc').notNull(),
  installedBySlackUser: text('installed_by_slack_user').notNull(),
  celebrationChannelId: text('celebration_channel_id'),
  defaultBudgetCents: integer('default_budget_cents').notNull().default(5000),
  timezone: text('timezone').notNull().default('America/New_York'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── users ───────────────────────────────────────────────────────────────────
// Admins who can approve. v1 has one admin per workspace (the installer).
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slackUserId: text('slack_user_id').notNull(),
    email: text('email'),
    name: text('name'),
    isAdmin: boolean('is_admin').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('users_workspace_slack_user_unique').on(t.workspaceId, t.slackUserId)],
);

// ─── people ──────────────────────────────────────────────────────────────────
// The roster. Not the same as users — a person may or may not have a Slack account.
// Birthday is stored as month + day (no year) for privacy.
export const people = pgTable(
  'people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    slackUserId: text('slack_user_id'),
    birthdayMonth: integer('birthday_month'),
    birthdayDay: integer('birthday_day'),
    startDate: date('start_date'),
    team: text('team'),
    role: text('role'),
    optedOut: boolean('opted_out').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('people_workspace_email_unique').on(t.workspaceId, t.email),
    index('people_birthday_idx').on(t.workspaceId, t.birthdayMonth, t.birthdayDay),
    index('people_start_date_idx').on(t.workspaceId, t.startDate),
  ],
);

// ─── events ──────────────────────────────────────────────────────────────────
// Detected upcoming moments. kind ∈ {'birthday','anniversary'}.
// status ∈ {'pending','approved','skipped','posted','cancelled'}.
// Unique constraint prevents the daily scan from creating duplicates.
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    eventDate: date('event_date').notNull(),
    years: integer('years'),
    status: text('status').notNull().default('pending'),
    // Slack channel + ts of the approval DM. Stashed when the DM is sent so
    // action handlers can chat.update in place. Both null until the DM goes out.
    approvalDmChannelId: text('approval_dm_channel_id'),
    approvalDmTs: text('approval_dm_ts'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('events_dedup_unique').on(t.workspaceId, t.personId, t.kind, t.eventDate),
    index('events_dayof_idx').on(t.workspaceId, t.eventDate, t.status),
    index('events_status_idx').on(t.status),
  ],
);

// ─── suggestions ─────────────────────────────────────────────────────────────
// What the agent proposed for an event. 2–3 rows per event normally.
export const suggestions = pgTable('suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  gestureSummary: text('gesture_summary').notNull(),
  gestureDetails: jsonb('gesture_details').notNull(),
  estimatedCostCents: integer('estimated_cost_cents').notNull(),
  rank: integer('rank').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── approvals ───────────────────────────────────────────────────────────────
// One per event. decision ∈ {'approved','skipped','modified'}.
export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id')
    .notNull()
    .unique()
    .references(() => events.id, { onDelete: 'cascade' }),
  approverUserId: uuid('approver_user_id')
    .notNull()
    .references(() => users.id),
  chosenSuggestionId: uuid('chosen_suggestion_id').references(() => suggestions.id),
  customGestureText: text('custom_gesture_text'),
  approvedBudgetCents: integer('approved_budget_cents'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  decision: text('decision').notNull(),
});

// ─── posts ───────────────────────────────────────────────────────────────────
// One per event. Records the celebration message + admin-reported spend.
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id')
    .notNull()
    .unique()
    .references(() => events.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
  slackTs: text('slack_ts').notNull(),
  threadTs: text('thread_ts'),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  actualSpendCents: integer('actual_spend_cents'),
  spendLoggedAt: timestamp('spend_logged_at', { withTimezone: true }),
});
