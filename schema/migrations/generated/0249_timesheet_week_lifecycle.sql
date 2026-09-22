-- OpenBooks forward migration 0249_timesheet_week_lifecycle.
--
-- 08f7aec0f shipped the timesheet week lifecycle schema — the timesheet_weeks
-- table family and time_entries.amends_entry_id — only inside the canonical
-- baseline, with no forward migration anywhere. Fresh bootstraps got it;
-- every database bootstrapped before that commit did not, and the gap then
-- surfaces as unrelated failures: 0070 raises 'governed query relation is
-- missing' for a fresh apply, the approval service queries a table that does
-- not exist, and the query console's frozen time_entries view cannot see the
-- amendment pointer. This migration carries that delta idempotently: every
-- statement is guarded with IF NOT EXISTS / OR REPLACE / an existence-check
-- DO block, so fresh installs replay it harmlessly over the baseline's
-- copies and upgraded installs get exactly the objects they lack.
--
-- Companion to the APPROVED_MIGRATION_TRANSITIONS entries that advance a
-- 0001 baseline ledger recorded at any pre-alpha.4 identity to the current
-- canonical digest: the identity advances there, the schema delta lands here.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- The amendment pointer: which entry an amending entry replaces. Nullable,
-- no default — existing rows amend nothing.
ALTER TABLE public.time_entries ADD COLUMN IF NOT EXISTS amends_entry_id uuid;

CREATE INDEX IF NOT EXISTS time_entries_amends
  ON public.time_entries USING btree (org_id, amends_entry_id)
  WHERE (amends_entry_id IS NOT NULL);

-- The week lifecycle document: one row per employee-week, Sunday-aligned,
-- with the four-state approval status.
CREATE TABLE IF NOT EXISTS public.timesheet_weeks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    week_start date NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    submitted_by uuid,
    submitted_at timestamp with time zone,
    approved_by uuid,
    approved_at timestamp with time zone,
    rejection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT timesheet_weeks_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT timesheet_weeks_week_start_is_sunday CHECK ((EXTRACT(dow FROM week_start) = (0)::numeric))
);

ALTER TABLE public.timesheet_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.timesheet_weeks FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'timesheet_weeks_pkey'
       AND conrelid = 'public.timesheet_weeks'::regclass
  ) THEN
    ALTER TABLE ONLY public.timesheet_weeks
      ADD CONSTRAINT timesheet_weeks_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS timesheet_weeks_employee_week
  ON public.timesheet_weeks USING btree (org_id, employee_party_id, week_start);
CREATE INDEX IF NOT EXISTS timesheet_weeks_status
  ON public.timesheet_weeks USING btree (org_id, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'timesheet_weeks_org_id_fkey'
       AND conrelid = 'public.timesheet_weeks'::regclass
  ) THEN
    ALTER TABLE ONLY public.timesheet_weeks
      ADD CONSTRAINT timesheet_weeks_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);
  END IF;
END
$$;

-- The tenant-isolation policy, byte-identical to the baseline's and to what
-- environments.sql writes. DROP IF EXISTS + CREATE keeps the text pinned and
-- the statement idempotent.
DROP POLICY IF EXISTS org_isolation ON public.timesheet_weeks;
CREATE POLICY org_isolation ON public.timesheet_weeks USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));
COMMENT ON POLICY org_isolation ON public.timesheet_weeks IS 'openbooks:org_isolation:v1';

-- The governed query-console projections. On fresh installs these are
-- OR REPLACE no-ops over the baseline's identical definitions; on upgraded
-- installs 0070 froze time_entries without the amendment pointer and never
-- created the weeks view at all.
CREATE OR REPLACE VIEW openbooks_query.time_entries WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    employee_party_id,
    worked_on,
    hours,
    time_type_id,
    item_id,
    project_id,
    project_task_id,
    department_id,
    memo,
    memo_is_private,
    is_billable,
    cost_rate,
    bill_rate,
    status,
    approved_by,
    approved_at,
    cost_journal_entry_id,
    invoiced_by_line_id,
    payroll_batch_ref,
    created_at,
    created_by,
    updated_at,
    updated_by,
    custom,
    overhead_journal_entry_id,
    field_ticket_id,
    labor_cost_rate_id,
    wage_rate,
    wage_currency,
    wage_fx_rate,
    cost_rate_currency,
    cost_rate_subsidiary_id,
    bill_rate_source_rate,
    bill_rate_source_currency,
    bill_rate_fx_rate,
    bill_rate_currency,
    bill_rate_book_id,
    bill_rate_version_id,
    bill_rate_line_id,
    billing_status,
    costing_basis,
    started_at,
    rejection_reason,
    amends_entry_id
   FROM public.time_entries
  WHERE (org_id = public.openbooks_query_org_id());

CREATE OR REPLACE VIEW openbooks_query.timesheet_weeks WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    employee_party_id,
    week_start,
    status,
    submitted_by,
    submitted_at,
    approved_by,
    approved_at,
    rejection_reason,
    created_at,
    created_by,
    updated_at,
    updated_by
   FROM public.timesheet_weeks
  WHERE (org_id = public.openbooks_query_org_id());

GRANT SELECT ON TABLE openbooks_query.timesheet_weeks TO openbooks_read;