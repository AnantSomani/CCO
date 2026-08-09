ALTER TABLE "agent_runs" ADD COLUMN "response_channel_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "response_message_ts" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "tool_calls" jsonb;