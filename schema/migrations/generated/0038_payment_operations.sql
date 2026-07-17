CREATE TABLE "payment_formats" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rail" text NOT NULL,
	"direction" text DEFAULT 'credit' NOT NULL,
	"country" text,
	"currency" text,
	"file_extension" text DEFAULT 'txt' NOT NULL,
	"content_type" text DEFAULT 'text/plain; charset=utf-8' NOT NULL,
	"formatter_script" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_bank_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"subsidiary_id" uuid,
	"payment_format_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"country" text,
	"originator_secrets_encrypted" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sftp_server_id" uuid,
	"sftp_folder" text,
	"require_run_approval" boolean DEFAULT true NOT NULL,
	"require_file_approval" boolean DEFAULT false NOT NULL,
	"auto_remittance" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payment_bank_profile_id" uuid NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"selection_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" text DEFAULT 'create_draft' NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_payment_run_id" uuid,
	"last_result" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_run_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_run_id" uuid NOT NULL,
	"payment_instruction_id" uuid,
	"source_document_id" uuid NOT NULL,
	"source_open_line_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"gross_amount" numeric(19,4) NOT NULL,
	"discount_amount" numeric(19,4) DEFAULT '0' NOT NULL,
	"credit_amount" numeric(19,4) DEFAULT '0' NOT NULL,
	"payment_amount" numeric(19,4) NOT NULL,
	"currency" text NOT NULL,
	"fx_rate" numeric(19,10) DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'selected' NOT NULL,
	"exclusion_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_files" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_run_id" uuid NOT NULL,
	"payment_bank_profile_id" uuid NOT NULL,
	"payment_format_id" uuid NOT NULL,
	"parent_payment_file_id" uuid,
	"sequence_number" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"content_hash" text NOT NULL,
	"file_id" uuid NOT NULL,
	"file_version_id" uuid NOT NULL,
	"payment_count" integer NOT NULL,
	"total_amount" numeric(19,4) NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'generated' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_file_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_file_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"target_ref" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"error" text,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_mandates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"party_bank_account_id" uuid NOT NULL,
	"scheme" text NOT NULL,
	"mandate_reference" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signed_on" date,
	"valid_from" date,
	"expires_on" date,
	"proof_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_settlements" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_instruction_id" uuid NOT NULL,
	"bank_statement_line_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" numeric(19,4) NOT NULL,
	"currency" text NOT NULL,
	"effective_on" date,
	"bank_reference" text,
	"return_code" text,
	"return_reason" text,
	"reversal_document_id" uuid,
	"reversal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_remittances" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_instruction_id" uuid NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_run_id" uuid NOT NULL,
	"payment_instruction_id" uuid,
	"payment_file_id" uuid,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_runs" ADD COLUMN "payment_bank_profile_id" uuid;
ALTER TABLE "payment_runs" ADD COLUMN "subsidiary_id" uuid;
ALTER TABLE "payment_runs" ADD COLUMN "source_schedule_id" uuid;
ALTER TABLE "payment_runs" ADD COLUMN "parent_payment_run_id" uuid;
ALTER TABLE "payment_runs" ADD COLUMN "direction" text DEFAULT 'outbound' NOT NULL;
ALTER TABLE "payment_runs" ADD COLUMN "purpose" text DEFAULT 'vendor_payments' NOT NULL;
ALTER TABLE "payment_runs" ADD COLUMN "currency" text;
ALTER TABLE "payment_runs" ADD COLUMN "selection_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "payment_runs" ADD COLUMN "payment_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "payment_runs" ADD COLUMN "total_amount" numeric(19,4) DEFAULT '0' NOT NULL;
ALTER TABLE "payment_runs" ADD COLUMN "submitted_at" timestamp with time zone;
ALTER TABLE "payment_runs" ADD COLUMN "submitted_by" uuid;
ALTER TABLE "payment_runs" ADD COLUMN "approved_at" timestamp with time zone;
ALTER TABLE "payment_runs" ADD COLUMN "approved_by" uuid;
ALTER TABLE "payment_runs" ADD COLUMN "rejected_at" timestamp with time zone;
ALTER TABLE "payment_runs" ADD COLUMN "rejected_by" uuid;
ALTER TABLE "payment_runs" ADD COLUMN "rejection_reason" text;
ALTER TABLE "payment_runs" ADD COLUMN "settled_at" timestamp with time zone;
ALTER TABLE "payment_instructions" ADD COLUMN "end_to_end_id" text;
ALTER TABLE "payment_instructions" ADD COLUMN "payment_reference" text;
ALTER TABLE "payment_instructions" ADD COLUMN "mandate_id" uuid;
UPDATE payment_runs r
   SET currency = o.base_currency,
       payment_count = (SELECT count(*)::integer FROM payment_instructions i
                         WHERE i.payment_run_id = r.id AND i.status <> 'cancelled'),
       total_amount = (SELECT coalesce(sum(i.amount), 0) FROM payment_instructions i
                        WHERE i.payment_run_id = r.id AND i.status <> 'cancelled')
  FROM orgs o
 WHERE o.id = r.org_id;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_formats_org_code" ON "payment_formats" ("org_id", "code");
CREATE INDEX "payment_formats_org_active" ON "payment_formats" ("org_id", "is_active");
CREATE UNIQUE INDEX "payment_bank_profiles_org_name" ON "payment_bank_profiles" ("org_id", "name");
CREATE INDEX "payment_bank_profiles_org_active" ON "payment_bank_profiles" ("org_id", "is_active");
CREATE UNIQUE INDEX "payment_schedules_org_name" ON "payment_schedules" ("org_id", "name");
CREATE INDEX "payment_schedules_due" ON "payment_schedules" ("is_active", "next_run_at");
CREATE INDEX "payment_run_items_run" ON "payment_run_items" ("payment_run_id");
CREATE INDEX "payment_run_items_instruction" ON "payment_run_items" ("payment_instruction_id");
CREATE UNIQUE INDEX "payment_run_items_source" ON "payment_run_items" ("payment_run_id", "source_open_line_id");
CREATE UNIQUE INDEX "payment_files_run_sequence" ON "payment_files" ("payment_run_id", "sequence_number");
CREATE INDEX "payment_files_hash" ON "payment_files" ("org_id", "content_hash");
CREATE INDEX "payment_files_run_status" ON "payment_files" ("payment_run_id", "status");
CREATE INDEX "payment_file_deliveries_file" ON "payment_file_deliveries" ("payment_file_id", "created_at");
CREATE UNIQUE INDEX "payment_mandates_org_reference" ON "payment_mandates" ("org_id", "mandate_reference");
CREATE INDEX "payment_mandates_party_status" ON "payment_mandates" ("party_id", "status");
CREATE UNIQUE INDEX "payment_settlements_instruction" ON "payment_settlements" ("payment_instruction_id");
CREATE INDEX "payment_settlements_status" ON "payment_settlements" ("org_id", "status");
CREATE INDEX "payment_remittances_instruction" ON "payment_remittances" ("payment_instruction_id", "created_at");
CREATE INDEX "payment_events_run_time" ON "payment_events" ("payment_run_id", "created_at");

GRANT SELECT ON payment_formats, payment_bank_profiles, payment_schedules,
  payment_run_items, payment_files, payment_file_deliveries, payment_mandates,
  payment_settlements, payment_remittances, payment_events TO openbooks_read;
