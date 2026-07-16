CREATE TABLE "account_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_catch_all" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "account_group_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_groups_org_dim_key" ON "account_groups" ("org_id","dimension","key");--> statement-breakpoint
CREATE INDEX "account_groups_org_dim" ON "account_groups" ("org_id","dimension");--> statement-breakpoint
CREATE UNIQUE INDEX "account_group_members_group_account" ON "account_group_members" ("group_id","account_id");--> statement-breakpoint
CREATE INDEX "account_group_members_account" ON "account_group_members" ("account_id");
