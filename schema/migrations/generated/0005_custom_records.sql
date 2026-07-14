CREATE TABLE "custom_record_types" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"plural_name" text NOT NULL,
	"icon_key" text DEFAULT 'grid' NOT NULL,
	"description" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"show_in_nav" boolean DEFAULT false NOT NULL,
	"allowed_roles" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "custom_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"type_key" text NOT NULL,
	"record_number" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "custom_record_types_org_key" ON "custom_record_types" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "custom_record_types_org_status" ON "custom_record_types" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_records_type_number" ON "custom_records" USING btree ("type_id","record_number");--> statement-breakpoint
CREATE INDEX "custom_records_org_type_status" ON "custom_records" USING btree ("org_id","type_key","status");--> statement-breakpoint
CREATE INDEX "custom_records_org_type_created" ON "custom_records" USING btree ("org_id","type_key","created_at");