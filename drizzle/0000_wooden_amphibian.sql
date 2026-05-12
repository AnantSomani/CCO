CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"chosen_suggestion_id" uuid,
	"custom_gesture_text" text,
	"approved_budget_cents" integer,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text NOT NULL,
	CONSTRAINT "approvals_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event_date" date NOT NULL,
	"years" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_dedup_unique" UNIQUE("workspace_id","person_id","kind","event_date")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"slack_user_id" text,
	"birthday_month" integer,
	"birthday_day" integer,
	"start_date" date,
	"team" text,
	"role" text,
	"opted_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_workspace_email_unique" UNIQUE("workspace_id","email")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"slack_ts" text NOT NULL,
	"thread_ts" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actual_spend_cents" integer,
	"spend_logged_at" timestamp with time zone,
	CONSTRAINT "posts_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"gesture_summary" text NOT NULL,
	"gesture_details" jsonb NOT NULL,
	"estimated_cost_cents" integer NOT NULL,
	"rank" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"email" text,
	"name" text,
	"is_admin" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_workspace_slack_user_unique" UNIQUE("workspace_id","slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_team_id" text NOT NULL,
	"bot_access_token_enc" text NOT NULL,
	"installed_by_slack_user" text NOT NULL,
	"celebration_channel_id" text,
	"default_budget_cents" integer DEFAULT 5000 NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slack_team_id_unique" UNIQUE("slack_team_id")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_chosen_suggestion_id_suggestions_id_fk" FOREIGN KEY ("chosen_suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_dayof_idx" ON "events" USING btree ("workspace_id","event_date","status");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "people_birthday_idx" ON "people" USING btree ("workspace_id","birthday_month","birthday_day");--> statement-breakpoint
CREATE INDEX "people_start_date_idx" ON "people" USING btree ("workspace_id","start_date");