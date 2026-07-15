CREATE TABLE "user_dashboard_layouts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_role" text NOT NULL,
	"is_customised" boolean DEFAULT false NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "role_dashboard_layouts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_dashboard_layouts_unique" ON "user_dashboard_layouts" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "role_dashboard_layouts_unique" ON "role_dashboard_layouts" USING btree ("org_id","role_key");
