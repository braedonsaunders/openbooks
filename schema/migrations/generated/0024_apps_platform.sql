ALTER TABLE "apps" ADD COLUMN "provisioned" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_scripts" ADD COLUMN "endpoint_slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "user_scripts_endpoint_slug" ON "user_scripts" USING btree ("org_id","endpoint_slug");--> statement-breakpoint
CREATE TABLE "app_listings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"publisher_org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon_key" text DEFAULT 'box' NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "app_listings_key" ON "app_listings" USING btree ("key");--> statement-breakpoint
CREATE INDEX "app_listings_publisher" ON "app_listings" USING btree ("publisher_org_id");
