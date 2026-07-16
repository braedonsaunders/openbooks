-- Migration platform: per-tenant external-system connections + run linkage.
-- Trimmed to only this change; drizzle-kit re-emitted pre-existing drift
-- (sftp_*, email_log, import_jobs, report_definitions/user_scripts/users)
-- because its snapshot was stale — those objects already exist everywhere.
-- Statements are idempotent so bootstrap can apply this safely.

CREATE TABLE IF NOT EXISTS "connections" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"display_name" text NOT NULL,
	"auth_kind" text DEFAULT 'token' NOT NULL,
	"status" text DEFAULT 'unconfigured' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"mirror_enabled" boolean DEFAULT false NOT NULL,
	"mirror_schedule" text DEFAULT 'daily' NOT NULL,
	"cursor" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN IF NOT EXISTS "connection_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_org" ON "connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connections_org_name" ON "connections" USING btree ("org_id","display_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_runs_connection" ON "sync_runs" USING btree ("connection_id","started_at");
