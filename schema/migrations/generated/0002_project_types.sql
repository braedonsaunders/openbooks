-- Configurable project types: profitability / invoicing / backup profiles.
CREATE TABLE IF NOT EXISTS "project_types" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"billing_method" text,
	"financial_profile" jsonb NOT NULL,
	"invoicing_profile" jsonb NOT NULL,
	"backup_profile" jsonb NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_types_org_key" ON "project_types" ("org_id", "key");
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "project_type_id" uuid;
