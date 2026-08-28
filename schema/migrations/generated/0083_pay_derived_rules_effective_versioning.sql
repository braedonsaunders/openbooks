-- OpenBooks forward migration 0083_pay_derived_rules_effective_versioning.
--
-- Derived-pay rules are resolved by pay-period end. The old natural key
-- (org_id, code) forced the Setup route to update the one row in place, so a
-- rate/filter edit silently changed the rule used to explain an already-paid
-- period. Versions share a code but have distinct effective starts; the old
-- version is closed by the API at the day before the successor starts.
--
-- The unique index prevents two versions beginning on the same date. The GiST
-- exclusion constraint prevents overlapping active windows for the same rule,
-- including concurrent writers. The trigger makes the versioning invariant
-- storage-owned for direct SQL and import writers too: only closing a window,
-- changing activation, and audit timestamps are mutable in place.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

DROP INDEX IF EXISTS public.pay_derived_rules_org_code;
CREATE UNIQUE INDEX IF NOT EXISTS pay_derived_rules_org_code_effective
  ON public.pay_derived_rules USING btree (org_id, code, effective_from);

-- PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`. Keep the DDL replay-safe
-- by checking the catalog before adding the named constraint. The predicate
-- and range expression remain the same storage-owned overlap invariant.
DO $pay_derived_rules_no_active_overlap$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname = 'pay_derived_rules'
       AND c.conname = 'pay_derived_rules_no_active_overlap'
  ) THEN
    ALTER TABLE public.pay_derived_rules
      ADD CONSTRAINT pay_derived_rules_no_active_overlap
      EXCLUDE USING gist (
        org_id WITH =,
        code WITH =,
        (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
      )
      WHERE (is_active);
  END IF;
END
$pay_derived_rules_no_active_overlap$;

COMMENT ON CONSTRAINT pay_derived_rules_no_active_overlap
  ON public.pay_derived_rules IS
  'openbooks:pay_derived_rules_effective_versioning:v1 - one active derived-pay rule window per organization and code; inclusive effective windows may not overlap';

CREATE OR REPLACE FUNCTION public.pay_derived_rules_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.org_id, NEW.code, NEW.name, NEW.component_id, NEW.trigger,
      NEW.time_type_id, NEW.project_id, NEW.department_id,
      NEW.equipment_unit_id, NEW.item_id, NEW.trade_id, NEW.job_title,
      NEW.billable_only, NEW.included_job_titles, NEW.excluded_job_titles,
      NEW.quantity_mode, NEW.rate_mode, NEW.rate_value, NEW.costing_mode,
      NEW.effective_from, NEW.sequence
    ) IS DISTINCT FROM ROW(
      OLD.org_id, OLD.code, OLD.name, OLD.component_id, OLD.trigger,
      OLD.time_type_id, OLD.project_id, OLD.department_id,
      OLD.equipment_unit_id, OLD.item_id, OLD.trade_id, OLD.job_title,
      OLD.billable_only, OLD.included_job_titles, OLD.excluded_job_titles,
      OLD.quantity_mode, OLD.rate_mode, OLD.rate_value, OLD.costing_mode,
      OLD.effective_from, OLD.sequence
    ) THEN
      RAISE EXCEPTION
        'derived payroll rules are immutable; close it and create a new effective-dated rule'
        USING ERRCODE = '55000';
    END IF;

    -- A policy window may be shortened (the route closes it immediately before
    -- inserting a successor), but never extended after the fact. Activation is
    -- intentionally mutable so a newly-created disabled rule can be enabled.
    IF OLD.effective_to IS NOT NULL
       AND (NEW.effective_to IS NULL OR NEW.effective_to > OLD.effective_to) THEN
      RAISE EXCEPTION
        'derived payroll rule windows may only be shortened; create a new effective-dated rule'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pay_derived_rules_immutable_guard() IS
  'openbooks:pay_derived_rules_immutable_guard:v1 - derived-pay policy snapshots are immutable; only window closure, activation, and audit timestamps may change in place';

DROP TRIGGER IF EXISTS pay_derived_rules_immutable ON public.pay_derived_rules;
CREATE TRIGGER pay_derived_rules_immutable
  BEFORE UPDATE ON public.pay_derived_rules
  FOR EACH ROW EXECUTE FUNCTION public.pay_derived_rules_immutable_guard();
