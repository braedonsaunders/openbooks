CREATE TABLE "pdf_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"paper_size" text DEFAULT 'letter' NOT NULL,
	"orientation" text DEFAULT 'portrait' NOT NULL,
	"margin_mm" integer DEFAULT 14 NOT NULL,
	"header_html" text,
	"footer_html" text,
	"source_html" text DEFAULT '' NOT NULL,
	"compiled_html" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pdf_templates_org_type_name" ON "pdf_templates" USING btree ("org_id","record_type","name");--> statement-breakpoint
CREATE INDEX "pdf_templates_org_type" ON "pdf_templates" USING btree ("org_id","record_type","is_default");
