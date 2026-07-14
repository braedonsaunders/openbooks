CREATE TABLE "app_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "user_permission_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"effect" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "org_nav_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "form_response_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"response_id" uuid NOT NULL,
	"actor" uuid,
	"action" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_responses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "form_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema" jsonb NOT NULL,
	"changelog" text,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "form_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"kind" text DEFAULT 'form' NOT NULL,
	"allowed_roles" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_roles_org_key" ON "app_roles" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "app_roles_org" ON "app_roles" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_org_user_role" ON "role_assignments" USING btree ("org_id","user_id","role_id");--> statement-breakpoint
CREATE INDEX "role_assignments_user" ON "role_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "role_assignments_role" ON "role_assignments" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_permission_overrides_user_permission" ON "user_permission_overrides" USING btree ("user_id","permission");--> statement-breakpoint
CREATE INDEX "user_permission_overrides_org" ON "user_permission_overrides" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_nav_configs_org" ON "org_nav_configs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "form_response_steps_response" ON "form_response_steps" USING btree ("response_id","at");--> statement-breakpoint
CREATE INDEX "form_responses_org_template" ON "form_responses" USING btree ("org_id","template_key","submitted_at");--> statement-breakpoint
CREATE INDEX "form_responses_version" ON "form_responses" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "form_responses_org_status" ON "form_responses" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "form_template_versions_template_version" ON "form_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE INDEX "form_template_versions_org" ON "form_template_versions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_templates_org_key" ON "form_templates" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "form_templates_org_status" ON "form_templates" USING btree ("org_id","status");