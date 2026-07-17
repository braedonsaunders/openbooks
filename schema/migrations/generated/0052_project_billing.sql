CREATE TABLE "billing_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"request_number" text NOT NULL,
	"invoice_type" text DEFAULT 'progress' NOT NULL,
	"basis" text DEFAULT 'date_range' NOT NULL,
	"draw_amount" numeric(19, 4),
	"start_date" date,
	"cutoff_date" date,
	"invoice_description" text,
	"customer_po" text,
	"billing_method_snapshot" text,
	"backup_required" boolean DEFAULT false NOT NULL,
	"backup_type" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"invoice_document_id" uuid,
	"selected_time_entry_ids" jsonb,
	"notes" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "billing_requests_invoice_type_check" CHECK ("invoice_type" IN ('progress','final')),
	CONSTRAINT "billing_requests_basis_check" CHECK ("basis" IN ('date_range','draw_amount','time_selection','milestone')),
	CONSTRAINT "billing_requests_billing_method_check" CHECK ("billing_method_snapshot" IS NULL OR "billing_method_snapshot" IN ('time_and_materials','fixed_price','cost_plus')),
	CONSTRAINT "billing_requests_backup_type_check" CHECK ("backup_type" IN ('none','costed_timesheets','quote_only','timesheets_purchases','purchases','purchases_shop_time')),
	CONSTRAINT "billing_requests_status_check" CHECK ("status" IN ('open','invoiced','closed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "billing_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"scheduled_date" date,
	"milestone" text,
	"percent_complete" numeric(19, 4),
	"amount_billed" numeric(19, 4),
	"percent_billed" numeric(19, 4),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"billing_request_id" uuid,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "invoice_backups" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"billing_request_id" uuid,
	"backup_type" text NOT NULL,
	"file_id" uuid NOT NULL,
	"page_count" integer,
	"component_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "billing_requests_project" ON "billing_requests" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_requests_org_number" ON "billing_requests" USING btree ("org_id","request_number");--> statement-breakpoint
CREATE INDEX "billing_schedules_project" ON "billing_schedules" USING btree ("org_id","project_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_backups_document" ON "invoice_backups" USING btree ("org_id","document_id");
