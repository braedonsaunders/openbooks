-- Import jobs — history for the generic bulk importer (web/lib/data-io).
-- One row per committed import run (dry-run previews are not persisted).
-- FKs (org_id, created_by) are added by referential-integrity.sql.

CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"resource_key" text NOT NULL,
	"resource_label" text,
	"format" text NOT NULL,
	"file_name" text,
	"mode" text DEFAULT 'upsert' NOT NULL,
	"status" text DEFAULT 'committed' NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE INDEX "import_jobs_org_created" ON "import_jobs" USING btree ("org_id","created_at");

-- Read role grant (applied by the DBA / seed pass):
-- grant select on import_jobs to openbooks_read;
