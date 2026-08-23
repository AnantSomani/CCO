CREATE TABLE "agent_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'collecting' NOT NULL,
	"slots" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_slots" text[] DEFAULT '{}'::text[] NOT NULL,
	"fire_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"channel_id" text,
	"thread_ts" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_user_message_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_turns" ADD CONSTRAINT "agent_session_turns_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_turns" ADD CONSTRAINT "agent_session_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_artifacts_session_status_idx" ON "agent_artifacts" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "agent_artifacts_workspace_kind_idx" ON "agent_artifacts" USING btree ("workspace_id","kind","status");--> statement-breakpoint
CREATE INDEX "agent_artifacts_reminder_due_idx" ON "agent_artifacts" USING btree ("fire_at","status");--> statement-breakpoint
CREATE INDEX "agent_session_turns_session_created_idx" ON "agent_session_turns" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_session_turns_workspace_idx" ON "agent_session_turns" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_one_open_idx" ON "agent_sessions" USING btree ("workspace_id","slack_user_id") WHERE "agent_sessions"."status" in ('active', 'waiting_for_user', 'pending_approval');--> statement-breakpoint
CREATE INDEX "agent_sessions_workspace_user_idx" ON "agent_sessions" USING btree ("workspace_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_expires_idx" ON "agent_sessions" USING btree ("expires_at","status");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_session_idx" ON "agent_runs" USING btree ("session_id");