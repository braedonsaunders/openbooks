ALTER TABLE "orgs" ADD COLUMN "env_kind" text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "sandbox_of" uuid;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "sandbox_seed" uuid;--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"production_org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tier" text DEFAULT 'masked' NOT NULL,
	"masked" boolean DEFAULT true NOT NULL,
	"as_of_period_id" uuid,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"last_error" text,
	"last_refresh_at" timestamp with time zone,
	"refresh_schedule" text,
	"refresh_keep_customizations" boolean DEFAULT true NOT NULL,
	"storage_rows" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "masking_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"transform" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "change_sets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"sandbox_org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "change_set_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"change_set_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"target_id" uuid NOT NULL,
	"op" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_org" ON "sandboxes" ("org_id");--> statement-breakpoint
CREATE INDEX "sandboxes_production" ON "sandboxes" ("production_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "masking_policies_col" ON "masking_policies" ("org_id","table_name","column_name");--> statement-breakpoint
CREATE INDEX "change_sets_org" ON "change_sets" ("org_id");--> statement-breakpoint
CREATE INDEX "change_set_items_set" ON "change_set_items" ("change_set_id");
