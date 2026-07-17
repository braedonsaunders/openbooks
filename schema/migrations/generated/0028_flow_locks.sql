-- Flow-managed record locks (the lock_record action) + bank-detail approval
-- status (the replicated NetSuite "Vendor Bank Details Approval" workflow).
CREATE TABLE "flow_locks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"reason" text,
	"exempt_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flow_locks_subject" ON "flow_locks" ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "flow_locks_org" ON "flow_locks" ("org_id","subject_kind");--> statement-breakpoint
ALTER TABLE "party_bank_accounts" ADD COLUMN "approval_status" text DEFAULT 'approved' NOT NULL;
