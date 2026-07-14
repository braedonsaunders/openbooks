CREATE TABLE "accounting_books" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"period_number" integer NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"is_adjustment" boolean DEFAULT false NOT NULL,
	"ar_closed_at" timestamp with time zone,
	"ap_closed_at" timestamp with time zone,
	"gl_closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"minor_units" integer DEFAULT 2 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"as_of" date NOT NULL,
	"rate_type" text DEFAULT 'spot' NOT NULL,
	"rate" numeric(19, 10) NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "intercompany_pairs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"from_org_id" uuid NOT NULL,
	"to_org_id" uuid NOT NULL,
	"due_from_account_id" uuid NOT NULL,
	"due_to_account_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_kind" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"padding" integer DEFAULT 5 NOT NULL,
	"gapless" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"legal_name" text,
	"base_currency" text NOT NULL,
	"country" text NOT NULL,
	"tax_ids" jsonb DEFAULT '{}'::jsonb,
	"is_elimination" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_cards" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"holder_party_id" uuid NOT NULL,
	"liability_account_id" uuid NOT NULL,
	"label" text NOT NULL,
	"last_four" text,
	"network" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"customer_id" uuid,
	"foreman_id" uuid,
	"manager_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"billing_method" text,
	"customer_po_number" text,
	"starts_on" date,
	"ends_on" date,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"number" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"is_summary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"currency_restriction" text,
	"eliminate" boolean DEFAULT false NOT NULL,
	"reconcilable" boolean DEFAULT false NOT NULL,
	"required_dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"label" text,
	"line1" text,
	"line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country" text,
	"is_default_billing" boolean DEFAULT false NOT NULL,
	"is_default_shipping" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "customer_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"ar_account_id" uuid,
	"payment_terms_id" uuid,
	"credit_limit" numeric(19, 4),
	"currency" text,
	"sales_rep_id" uuid,
	"tax_code_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "customer_roles_party_id_unique" UNIQUE("party_id")
);
--> statement-breakpoint
CREATE TABLE "employee_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"employee_number" text,
	"department_id" uuid,
	"supervisor_id" uuid,
	"trade_id" uuid,
	"worker_comp_group_id" uuid,
	"hired_on" date,
	"terminated_on" date,
	"has_benefits" boolean DEFAULT false NOT NULL,
	"vacation_days_per_year" integer,
	"billable_utilization_target" integer,
	"expense_account_id" uuid,
	"external_payroll_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "employee_roles_party_id_unique" UNIQUE("party_id")
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"short_code" text,
	"email" text,
	"phone" text,
	"website" text,
	"tax_ids" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "party_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"bank_name" text,
	"country" text,
	"currency" text,
	"routing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"account_number_encrypted" text,
	"account_last_four" text,
	"approved_at" date,
	"approved_by" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_terms" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"net_days" integer DEFAULT 30 NOT NULL,
	"discount_days" integer,
	"discount_percent" numeric(19, 4),
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"ap_account_id" uuid,
	"payment_terms_id" uuid,
	"default_expense_account_id" uuid,
	"payment_method" text,
	"eft_notification_email" text,
	"currency" text,
	"tax_code_id" uuid,
	"is_t4a" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "vendor_roles_party_id_unique" UNIQUE("party_id")
);
--> statement-breakpoint
CREATE TABLE "worker_comp_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_percent" numeric(19, 4),
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_line_id" uuid NOT NULL,
	"to_line_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"applied_on" date NOT NULL,
	"fx_gain_loss_entry_id" uuid,
	"unapplied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "app_positive" CHECK ("applications"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"entry_number" text NOT NULL,
	"posting_date" date NOT NULL,
	"period_id" uuid NOT NULL,
	"memo" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"source_document_id" uuid,
	"origin" text DEFAULT 'manual' NOT NULL,
	"reverses_entry_id" uuid,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"txn_amount" numeric(19, 4) NOT NULL,
	"fx_rate" numeric(19, 10) DEFAULT '1' NOT NULL,
	"memo" text,
	"party_id" uuid,
	"department_id" uuid,
	"project_id" uuid,
	"location_id" uuid,
	"class_id" uuid,
	"payment_card_id" uuid,
	"extra_dims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quantity" numeric(19, 4),
	"unit" text,
	"due_date" date,
	"is_open_item" boolean DEFAULT false NOT NULL,
	"tax_code_id" uuid,
	"reconciled_at" timestamp with time zone,
	"reconciliation_id" uuid,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "jl_nonzero" CHECK ("journal_lines"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "document_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid,
	"account_id" uuid,
	"description" text,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit" text,
	"unit_price" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"tax_code_id" uuid,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"department_id" uuid,
	"project_id" uuid,
	"location_id" uuid,
	"class_id" uuid,
	"employee_id" uuid,
	"time_entry_id" uuid,
	"time_type_id" uuid,
	"cost_multiplier" numeric(19, 4),
	"is_billable" boolean DEFAULT false NOT NULL,
	"billed_by_line_id" uuid,
	"quantity_fulfilled" numeric(19, 4) DEFAULT '0' NOT NULL,
	"quantity_billed" numeric(19, 4) DEFAULT '0' NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "doc_lines_target" CHECK ("document_lines"."item_id" IS NOT NULL OR "document_lines"."account_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "document_links" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_document_id" uuid NOT NULL,
	"to_document_id" uuid NOT NULL,
	"link_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_number" text NOT NULL,
	"party_id" uuid,
	"document_date" date NOT NULL,
	"posting_date" date,
	"due_date" date,
	"currency" text NOT NULL,
	"fx_rate" numeric(19, 10) DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_entry_id" uuid,
	"voided_at" timestamp with time zone,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"department_id" uuid,
	"project_id" uuid,
	"location_id" uuid,
	"class_id" uuid,
	"payment_card_id" uuid,
	"billing_method" text,
	"is_final_invoice" boolean DEFAULT false NOT NULL,
	"reference_number" text,
	"internal_notes" text,
	"payment_hold_reason" text,
	"expected_pay_date" date,
	"memo" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"category" text,
	"income_account_id" uuid,
	"expense_account_id" uuid,
	"default_rate" numeric(19, 4),
	"unit" text,
	"tax_code_id" uuid,
	"show_on_timesheet" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "labor_burden_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"department_id" uuid,
	"category" text,
	"method" text DEFAULT 'live' NOT NULL,
	"rate_percent" numeric(19, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "time_types" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cost_multiplier" numeric(19, 4) DEFAULT '1' NOT NULL,
	"is_billable_default" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"region" text,
	"applies_to" text DEFAULT 'both' NOT NULL,
	"collected_account_id" uuid,
	"paid_account_id" uuid,
	"recoverable_percent" numeric(19, 4) DEFAULT '100' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tax_group_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tax_group_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"rate_percent" numeric(19, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tax_report_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"report_code" text NOT NULL,
	"line_code" text NOT NULL,
	"label" text NOT NULL,
	"tax_code_id" uuid,
	"basis" text NOT NULL,
	"sign" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_kind" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"amount" numeric(19, 4),
	"status" text DEFAULT 'pending' NOT NULL,
	"current_step" integer DEFAULT 1 NOT NULL,
	"submitted_by" uuid NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"assignee_party_id" uuid,
	"assignee_role" text,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"is_delegated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "custom_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"target_table" text NOT NULL,
	"target_kind" text,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "script_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"script_id" uuid NOT NULL,
	"target_kind" text,
	"target_id" uuid,
	"status" text NOT NULL,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"duration_ms" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_scripts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trigger_point" text NOT NULL,
	"document_kind" text,
	"source" text NOT NULL,
	"cron" text,
	"timeout_ms" integer DEFAULT 2000 NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bom_components" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"assembly_item_id" uuid NOT NULL,
	"component_item_id" uuid NOT NULL,
	"quantity_per" numeric(19, 4) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "cost_layer_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"cost_layer_id" uuid NOT NULL,
	"issue_movement_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "layer_consumptions_positive" CHECK ("cost_layer_consumptions"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "cost_layers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"source_movement_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"original_quantity" numeric(19, 4) NOT NULL,
	"remaining_quantity" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "cost_layers_remaining" CHECK ("cost_layers"."remaining_quantity" >= 0 AND "cost_layers"."remaining_quantity" <= "cost_layers"."original_quantity")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"moved_at" timestamp with time zone NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"lot_id" uuid,
	"serial_id" uuid,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4),
	"total_value" numeric(19, 4),
	"document_line_id" uuid,
	"journal_entry_id" uuid,
	"paired_movement_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "inv_moves_qty_nonzero" CHECK ("inventory_movements"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "item_inventory_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"costing_method" text DEFAULT 'moving_average' NOT NULL,
	"tracking" text DEFAULT 'none' NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"cogs_account_id" uuid NOT NULL,
	"adjustment_account_id" uuid,
	"variance_account_id" uuid,
	"standard_cost" numeric(19, 4),
	"base_unit" text DEFAULT 'ea' NOT NULL,
	"unit_conversions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reorder_point" numeric(19, 4),
	"preferred_stock_level" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "item_inventory_profiles_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE "landed_cost_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_document_line_id" uuid NOT NULL,
	"target_cost_layer_id" uuid NOT NULL,
	"basis" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_number" text NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "serials" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"current_stock_location_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"stock_location_id" uuid NOT NULL,
	"lot_id" uuid,
	"expected_quantity" numeric(19, 4) NOT NULL,
	"counted_quantity" numeric(19, 4),
	"adjustment_movement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"counted_on" date NOT NULL,
	"posted_entry_id" uuid,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"kind" text DEFAULT 'bin' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "performance_obligations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"document_line_id" uuid,
	"item_id" uuid,
	"description" text NOT NULL,
	"recognition_rule_id" uuid NOT NULL,
	"standalone_selling_price" numeric(19, 4),
	"allocated_price" numeric(19, 4) NOT NULL,
	"percent_complete" numeric(19, 4),
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "recognition_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"method" text NOT NULL,
	"deferred_account_id" uuid NOT NULL,
	"recognized_account_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "recognition_schedule_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"planned_amount" numeric(19, 4) NOT NULL,
	"recognized_amount" numeric(19, 4),
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "recognition_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"total_amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "revenue_contracts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"contract_number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"total_transaction_price" numeric(19, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "asset_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"accumulated_depreciation_account_id" uuid NOT NULL,
	"depreciation_expense_account_id" uuid NOT NULL,
	"gain_loss_account_id" uuid,
	"default_method" text DEFAULT 'straight_line' NOT NULL,
	"default_life_months" integer,
	"tax_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "asset_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_on" date NOT NULL,
	"amount" numeric(19, 4),
	"journal_entry_id" uuid,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "depreciation_schedule_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"planned_amount" numeric(19, 4) NOT NULL,
	"posted_amount" numeric(19, 4),
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "depreciation_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"method" text NOT NULL,
	"life_months" integer,
	"rate_percent" numeric(19, 4),
	"units_total" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"asset_number" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"acquired_on" date,
	"in_service_on" date,
	"acquisition_cost" numeric(19, 4) NOT NULL,
	"salvage_value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"source_document_line_id" uuid,
	"serial_number" text,
	"department_id" uuid,
	"project_id" uuid,
	"location_id" uuid,
	"custodian_party_id" uuid,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_match_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"posted_on" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"counterparty_ref" text,
	"bank_transaction_id" text,
	"match_status" text DEFAULT 'unmatched' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source" text NOT NULL,
	"statement_date" date NOT NULL,
	"opening_balance" numeric(19, 4),
	"closing_balance" numeric(19, 4),
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_file_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_instructions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_run_id" uuid NOT NULL,
	"payee_party_id" uuid NOT NULL,
	"payee_bank_account_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"payment_document_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"remittance_email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "payment_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_number" text NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_for" date,
	"exported_file_ref" text,
	"exported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "reconciliation_matches" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"reconciliation_id" uuid,
	"statement_line_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"matched_by" text NOT NULL,
	"confidence" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"through_date" date NOT NULL,
	"statement_balance" numeric(19, 4) NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"signed_off_by" uuid,
	"signed_off_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "allocation_rule_targets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"target_account_id" uuid NOT NULL,
	"department_id" uuid,
	"project_id" uuid,
	"location_id" uuid,
	"class_id" uuid,
	"fixed_percent" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "allocation_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"basis" text NOT NULL,
	"basis_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"offset_account_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "allocation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"status" text NOT NULL,
	"total_allocated" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid,
	"computation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"department_id" uuid,
	"project_id" uuid,
	"location_id" uuid,
	"class_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "budget_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'budget' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "project_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text,
	"name" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"estimated_hours" numeric(19, 4),
	"estimated_cost" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "recurring_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_document_id" uuid NOT NULL,
	"cadence" text NOT NULL,
	"cron" text,
	"next_run_on" date NOT NULL,
	"ends_on" date,
	"auto_post" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"employee_party_id" uuid NOT NULL,
	"worked_on" date NOT NULL,
	"hours" numeric(19, 4) NOT NULL,
	"time_type_id" uuid,
	"item_id" uuid,
	"project_id" uuid,
	"project_task_id" uuid,
	"department_id" uuid,
	"memo" text,
	"memo_is_private" boolean DEFAULT false NOT NULL,
	"is_billable" boolean DEFAULT false NOT NULL,
	"cost_rate" numeric(19, 4),
	"bill_rate" numeric(19, 4),
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"cost_journal_entry_id" uuid,
	"invoiced_by_line_id" uuid,
	"payroll_batch_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "books_org_code" ON "accounting_books" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "periods_org_year_num" ON "accounting_periods" USING btree ("org_id","fiscal_year","period_number");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_pair_date_type" ON "fx_rates" USING btree ("from_currency","to_currency","as_of","rate_type");--> statement-breakpoint
CREATE UNIQUE INDEX "intercompany_org_pair" ON "intercompany_pairs" USING btree ("from_org_id","to_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sequences_org_kind" ON "number_sequences" USING btree ("org_id","document_kind");--> statement-breakpoint
CREATE INDEX "projects_customer" ON "projects" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_number" ON "accounts" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "accounts_org_type" ON "accounts" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "accounts_parent" ON "accounts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "addresses_party" ON "addresses" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "parties_org_name" ON "parties" USING btree ("org_id","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_org_shortcode" ON "parties" USING btree ("org_id","short_code");--> statement-breakpoint
CREATE INDEX "bank_accounts_party" ON "party_bank_accounts" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "app_from" ON "applications" USING btree ("from_line_id");--> statement-breakpoint
CREATE INDEX "app_to" ON "applications" USING btree ("to_line_id");--> statement-breakpoint
CREATE INDEX "je_org_date" ON "journal_entries" USING btree ("org_id","posting_date");--> statement-breakpoint
CREATE INDEX "je_org_period" ON "journal_entries" USING btree ("org_id","period_id");--> statement-breakpoint
CREATE INDEX "je_source_doc" ON "journal_entries" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "jl_entry" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "jl_org_account" ON "journal_lines" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "jl_org_project" ON "journal_lines" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "jl_org_party_open" ON "journal_lines" USING btree ("org_id","party_id","is_open_item");--> statement-breakpoint
CREATE INDEX "doc_lines_document" ON "document_lines" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "doc_lines_project_billable" ON "document_lines" USING btree ("project_id","is_billable");--> statement-breakpoint
CREATE INDEX "doc_links_from" ON "document_links" USING btree ("from_document_id");--> statement-breakpoint
CREATE INDEX "doc_links_to" ON "document_links" USING btree ("to_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_org_kind_number" ON "documents" USING btree ("org_id","kind","document_number");--> statement-breakpoint
CREATE INDEX "documents_org_kind_status" ON "documents" USING btree ("org_id","kind","status");--> statement-breakpoint
CREATE INDEX "documents_party" ON "documents" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "documents_project" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_code" ON "items" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "tax_rates_code" ON "tax_rates" USING btree ("tax_code_id");--> statement-breakpoint
CREATE INDEX "approval_requests_target" ON "approval_requests" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "approval_requests_status" ON "approval_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "approval_steps_request" ON "approval_steps" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "audit_log_row" ON "audit_log" USING btree ("table_name","row_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_at" ON "audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "custom_field_defs_target" ON "custom_field_defs" USING btree ("org_id","target_table","target_kind");--> statement-breakpoint
CREATE INDEX "script_runs_script" ON "script_runs" USING btree ("script_id","at");--> statement-breakpoint
CREATE INDEX "user_scripts_trigger" ON "user_scripts" USING btree ("org_id","trigger_point","document_kind","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "bom_assembly_component" ON "bom_components" USING btree ("assembly_item_id","component_item_id");--> statement-breakpoint
CREATE INDEX "layer_consumptions_layer" ON "cost_layer_consumptions" USING btree ("cost_layer_id");--> statement-breakpoint
CREATE INDEX "layer_consumptions_movement" ON "cost_layer_consumptions" USING btree ("issue_movement_id");--> statement-breakpoint
CREATE INDEX "cost_layers_item_loc_fifo" ON "cost_layers" USING btree ("item_id","stock_location_id","received_at");--> statement-breakpoint
CREATE INDEX "inv_moves_item_loc" ON "inventory_movements" USING btree ("item_id","stock_location_id");--> statement-breakpoint
CREATE INDEX "inv_moves_doc_line" ON "inventory_movements" USING btree ("document_line_id");--> statement-breakpoint
CREATE INDEX "landed_cost_source" ON "landed_cost_allocations" USING btree ("source_document_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lots_item_number" ON "lots" USING btree ("item_id","lot_number");--> statement-breakpoint
CREATE UNIQUE INDEX "serials_item_number" ON "serials" USING btree ("item_id","serial_number");--> statement-breakpoint
CREATE INDEX "count_lines_count" ON "stock_count_lines" USING btree ("stock_count_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_locations_org_code" ON "stock_locations" USING btree ("org_id","location_id","code");--> statement-breakpoint
CREATE INDEX "obligations_contract" ON "performance_obligations" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "rec_lines_schedule" ON "recognition_schedule_lines" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "rec_lines_period" ON "recognition_schedule_lines" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "rec_schedules_obligation" ON "recognition_schedules" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "rev_contracts_customer" ON "revenue_contracts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "asset_events_asset" ON "asset_events" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "depr_lines_schedule" ON "depreciation_schedule_lines" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "depr_lines_period" ON "depreciation_schedule_lines" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "depr_schedules_asset" ON "depreciation_schedules" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "assets_org_status" ON "fixed_assets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "stmt_lines_statement" ON "bank_statement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "stmt_lines_match_status" ON "bank_statement_lines" USING btree ("org_id","match_status");--> statement-breakpoint
CREATE INDEX "statements_account_date" ON "bank_statements" USING btree ("account_id","statement_date");--> statement-breakpoint
CREATE INDEX "pay_instructions_run" ON "payment_instructions" USING btree ("payment_run_id");--> statement-breakpoint
CREATE INDEX "recon_matches_stmt_line" ON "reconciliation_matches" USING btree ("statement_line_id");--> statement-breakpoint
CREATE INDEX "recon_matches_journal_line" ON "reconciliation_matches" USING btree ("journal_line_id");--> statement-breakpoint
CREATE INDEX "recons_account" ON "reconciliations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "alloc_targets_rule" ON "allocation_rule_targets" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "alloc_runs_rule_period" ON "allocation_runs" USING btree ("rule_id","period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_lines_cell" ON "budget_lines" USING btree ("scenario_id","account_id","period_id","department_id","project_id","location_id","class_id");--> statement-breakpoint
CREATE INDEX "budget_lines_scenario" ON "budget_lines" USING btree ("scenario_id");--> statement-breakpoint
CREATE INDEX "project_tasks_project" ON "project_tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "recurring_next_run" ON "recurring_schedules" USING btree ("is_active","next_run_on");--> statement-breakpoint
CREATE INDEX "time_entries_employee_date" ON "time_entries" USING btree ("employee_party_id","worked_on");--> statement-breakpoint
CREATE INDEX "time_entries_project" ON "time_entries" USING btree ("project_id","is_billable");--> statement-breakpoint
CREATE INDEX "time_entries_status" ON "time_entries" USING btree ("org_id","status");