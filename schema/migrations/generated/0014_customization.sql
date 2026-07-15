-- Transaction form + record list customization (per-tenant custom forms +
-- per-user preferred forms; saved list views, org-shared + personal).
-- Config blobs (FormLayoutConfig / ListViewConfig) validated by the API via
-- @openbooks/customization. FKs added by referential-integrity.sql.

CREATE TABLE "form_layouts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"allowed_roles" jsonb,
	"layout" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "form_layouts_org_type_name" ON "form_layouts" ("org_id", "record_type", "name");
--> statement-breakpoint
CREATE INDEX "form_layouts_org_type" ON "form_layouts" ("org_id", "record_type", "is_default");
--> statement-breakpoint
CREATE TABLE "user_form_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"layout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_form_prefs_user_type" ON "user_form_preferences" ("org_id", "user_id", "record_type");
--> statement-breakpoint
CREATE TABLE "list_views" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"owner_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "list_views_org_scope_type_name" ON "list_views" ("org_id", "scope", "record_type", "name");
--> statement-breakpoint
CREATE INDEX "list_views_org_type" ON "list_views" ("org_id", "record_type", "scope");
--> statement-breakpoint
CREATE TABLE "user_list_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"view_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_list_prefs_user_type" ON "user_list_preferences" ("org_id", "user_id", "record_type");

-- Post-migration: grant select on new tables to the read-only role
-- grant select on form_layouts, user_form_preferences, list_views, user_list_preferences to openbooks_read;
