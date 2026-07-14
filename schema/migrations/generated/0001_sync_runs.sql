CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text DEFAULT 'incremental' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"synced_through" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"triggered_by" text
);
--> statement-breakpoint
CREATE INDEX "sync_runs_org_started" ON "sync_runs" USING btree ("org_id","started_at");