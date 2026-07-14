CREATE TABLE "insight_cards" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"viz_type" text DEFAULT 'table' NOT NULL,
	"viz_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"allowed_roles" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "insight_dashboard_pins" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_dashboards" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"layout" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"allowed_roles" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "insight_cards_org_status" ON "insight_cards" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "insight_cards_org_name" ON "insight_cards" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "insight_pins_user" ON "insight_dashboard_pins" USING btree ("org_id","user_id","sort_order");--> statement-breakpoint
CREATE INDEX "insight_pins_dashboard" ON "insight_dashboard_pins" USING btree ("dashboard_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insight_pins_unique" ON "insight_dashboard_pins" USING btree ("user_id","dashboard_id");--> statement-breakpoint
CREATE INDEX "insight_dashboards_org_status" ON "insight_dashboards" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "insight_dashboards_org_name" ON "insight_dashboards" USING btree ("org_id","name");