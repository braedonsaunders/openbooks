-- OpenBooks forward migration 0181_payroll_holiday_eligibility.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Statutory-holiday attestation facts, stored where they belong. The engine
-- (engine/src/payroll-holidays.ts) fails closed whenever a declaring rule's
-- fact is missing: commission-pay status and the last-and-first-shift absence
-- assertion must be ANSWERED, never inferred from a timesheet gap — an
-- absence in the data is as likely to be approved leave, so inferring consent
-- would deny statutory pay on a guess (see payroll-holidays.ts:700-707).
-- Until this migration those facts could only ride the per-request
-- `holidayEligibility` map into calculatePayRun: accepted, used once, and
-- never persisted, so a recalculate returned the identical refusal and the
-- operator had nowhere to record either answer. This migration stores both,
-- as two different kinds of fact:
--
--   paid_on_commission  a STANDING employment attribute on
--                       employee_payroll_profiles. Whether someone is paid in
--                       whole or in part on commission does not change between
--                       pay periods, so it is answered ONCE. Nullable with NO
--                       default: null means UNANSWERED and the engine keeps
--                       failing closed exactly as a missing per-request entry
--                       does. A default of false would answer for the operator
--                       silently and reintroduce the guess the engine refuses
--                       to make.
--
--   pay_run_holiday_assertions  the PER-HOLIDAY absence assertion, one row per
--                       (run, employee, holiday occurrence). The key carries
--                       the holiday (pack-declared key + observed date), and
--                       the run scopes the period: an assertion around one
--                       holiday says nothing about the next, and a later run
--                       cannot inherit an earlier run's row. The asserted value
--                       is stored either way (true AND false): the engine only
--                       disqualifies on true, but persisting an explicit false
--                       is what stops the next recalculate from re-asking.
--
-- The per-request map still wins where both exist: it is the override, the
-- stored value the fallback. Nothing here names a country, a holiday, or a
-- statute — holiday_key is the pack's own declaration (or the tenant company
-- row id), so this surface works for any pack that declares a rule with
-- these qualifiers.
--
-- Additive, ledger-tracked, no history reinterpretation. Existing rows keep
-- null (unanswered) and calculate exactly as before.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The standing commission-pay attribute. Three-state by design: null is
-- "nobody has answered", not "not on commission".
ALTER TABLE public.employee_payroll_profiles ADD COLUMN paid_on_commission boolean;

COMMENT ON COLUMN public.employee_payroll_profiles.paid_on_commission IS
  'Whether the employee is paid in whole or in part on commission, for statutory-holiday rules that read it. Null = unanswered: the engine fails closed exactly as a missing per-request entry does. Never default this to false — a silent false answers for the operator and reintroduces the inference payroll-holidays.ts:700-707 refuses to make.';

CREATE TABLE IF NOT EXISTS public.pay_run_holiday_assertions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    pay_run_document_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    -- The pack's own holiday declaration key (or the tenant company-holiday
    -- row id), plus the observed date of the occurrence asserted about. Both
    -- are needed: one period can hold several paid holidays.
    holiday_key text NOT NULL,
    holiday_date date NOT NULL,
    -- The employer's assertion: true = absent WITHOUT consent on the last
    -- scheduled shift before or the first after. Stored either way; only
    -- true disqualifies, but an explicit false is what stops re-asking.
    absent_without_consent boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT pay_run_holiday_assertions_key_not_blank CHECK (length(btrim(holiday_key)) > 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pay_run_holiday_assertions_pkey'
  ) THEN
    ALTER TABLE ONLY public.pay_run_holiday_assertions
      ADD CONSTRAINT pay_run_holiday_assertions_pkey PRIMARY KEY (id);
  END IF;
END
$$;

-- One assertion per (run, employee, holiday occurrence): re-asserting the
-- same holiday upserts, it never duplicates.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pay_run_holiday_assertions_once_per_holiday'
  ) THEN
    ALTER TABLE ONLY public.pay_run_holiday_assertions
      ADD CONSTRAINT pay_run_holiday_assertions_once_per_holiday
      UNIQUE (org_id, pay_run_document_id, employee_party_id, holiday_key, holiday_date);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pay_run_holiday_assertions_org_id_fkey'
  ) THEN
    ALTER TABLE ONLY public.pay_run_holiday_assertions
      ADD CONSTRAINT pay_run_holiday_assertions_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pay_run_holiday_assertions_run_fkey'
  ) THEN
    ALTER TABLE ONLY public.pay_run_holiday_assertions
      ADD CONSTRAINT pay_run_holiday_assertions_run_fkey
      FOREIGN KEY (pay_run_document_id) REFERENCES public.pay_runs(document_id) ON DELETE CASCADE DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pay_run_holiday_assertions_employee_fkey'
  ) THEN
    ALTER TABLE ONLY public.pay_run_holiday_assertions
      ADD CONSTRAINT pay_run_holiday_assertions_employee_fkey
      FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pay_run_holiday_assertions_created_by_fkey'
  ) THEN
    ALTER TABLE ONLY public.pay_run_holiday_assertions
      ADD CONSTRAINT pay_run_holiday_assertions_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pay_run_holiday_assertions_updated_by_fkey'
  ) THEN
    ALTER TABLE ONLY public.pay_run_holiday_assertions
      ADD CONSTRAINT pay_run_holiday_assertions_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS pay_run_holiday_assertions_run
  ON public.pay_run_holiday_assertions USING btree (org_id, pay_run_document_id, employee_party_id);

ALTER TABLE ONLY public.pay_run_holiday_assertions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'pay_run_holiday_assertions'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.pay_run_holiday_assertions
      USING (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      )
      WITH CHECK (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      );
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.pay_run_holiday_assertions IS 'openbooks:org_isolation:v1';

ALTER TABLE public.pay_run_holiday_assertions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pay_run_holiday_assertions IS
  'Per-(run, employee, holiday) statutory-holiday absence assertions: whether the employee was absent WITHOUT the employer''s consent on the last scheduled shift before or the first after the holiday. Scoped to the run so a later period never inherits an earlier assertion; re-asserting upserts on the once-per-holiday key.';
