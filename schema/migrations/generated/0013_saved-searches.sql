-- Saved searches — NetSuite Saved Search analogue (Knowledge menu).
-- A saved search is a named, shareable query over the @openbooks/reports entity
-- catalog (ledger_lines, documents, parties, accounts): detail rows OR a
-- grouped summary. The query plan IS ReportCustomQuery (same as report
-- definitions), executed by the same engine — no duplicate query compiler.
-- FKs (org_id, owner_id, created_by, updated_by) are added by
-- referential-integrity.sql.

CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"query" jsonb NOT NULL,
	"layout" jsonb,
	"scope" text DEFAULT 'private' NOT NULL,
	"owner_id" uuid NOT NULL,
	"allowed_roles" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "saved_searches_org_slug" ON "saved_searches" USING btree ("org_id","slug");
--> statement-breakpoint
CREATE INDEX "saved_searches_org_scope" ON "saved_searches" USING btree ("org_id","scope");
--> statement-breakpoint
CREATE INDEX "saved_searches_org_owner" ON "saved_searches" USING btree ("org_id","owner_id");
--> statement-breakpoint
CREATE INDEX "saved_searches_org_name" ON "saved_searches" USING btree ("org_id","name");

-- Read role grant (applied by the DBA / seed pass):
-- grant select on saved_searches to openbooks_read;
