CREATE TABLE "waitlist_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"source" text DEFAULT 'landing_page' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_signups_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "waitlist_signups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT INSERT ON TABLE "waitlist_signups" TO anon;
--> statement-breakpoint
CREATE POLICY "waitlist_signups_insert_anon"
ON "waitlist_signups"
AS PERMISSIVE
FOR INSERT
TO anon
WITH CHECK (true);
