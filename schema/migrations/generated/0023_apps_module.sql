CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon_key" text DEFAULT 'box' NOT NULL,
	"status" text DEFAULT 'installed' NOT NULL,
	"active_version_id" uuid,
	"granted_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"show_in_nav" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "app_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "app_files" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"content_type" text DEFAULT 'text/plain' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"is_binary" boolean DEFAULT false NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "app_storage" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"namespace" text DEFAULT 'default' NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "app_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"version_id" uuid,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"duration_ms" integer,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "apps_org_key" ON "apps" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "apps_org_status" ON "apps" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "app_versions_app_version" ON "app_versions" USING btree ("app_id","version");--> statement-breakpoint
CREATE INDEX "app_versions_org_app" ON "app_versions" USING btree ("org_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_files_version_path" ON "app_files" USING btree ("version_id","path");--> statement-breakpoint
CREATE INDEX "app_files_version_kind" ON "app_files" USING btree ("version_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "app_storage_scope_key" ON "app_storage" USING btree ("app_id","namespace","key");--> statement-breakpoint
CREATE INDEX "app_storage_org_app" ON "app_storage" USING btree ("org_id","app_id");--> statement-breakpoint
CREATE INDEX "app_runs_app_at" ON "app_runs" USING btree ("app_id","at");
