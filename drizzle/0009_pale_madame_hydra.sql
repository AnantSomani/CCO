CREATE TABLE "agent_doordash_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"checkpoint" text DEFAULT 'started' NOT NULL,
	"store_id" text NOT NULL,
	"cart_uuid" text,
	"approved_max_cents" integer NOT NULL,
	"live_total_cents" integer,
	"listed_cart_uuids" text[] DEFAULT '{}'::text[] NOT NULL,
	"item_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quote" jsonb,
	"error_code" text,
	"cart_idempotency_key" text NOT NULL,
	"items_idempotency_key" text NOT NULL,
	"preview_idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_doordash_executions_action_id_unique" UNIQUE("action_id")
);
--> statement-breakpoint
ALTER TABLE "agent_doordash_executions" ADD CONSTRAINT "agent_doordash_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_doordash_executions" ADD CONSTRAINT "agent_doordash_executions_action_id_agent_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."agent_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_doordash_executions_workspace_status_idx" ON "agent_doordash_executions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "agent_doordash_executions_cart_idx" ON "agent_doordash_executions" USING btree ("workspace_id","cart_uuid");