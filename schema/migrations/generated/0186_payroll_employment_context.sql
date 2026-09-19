-- OpenBooks forward migration 0186_payroll_employment_context.
--
-- WHAT THIS ADDS. A nullable `employment_id` on the ten payroll tables that
-- carry a person (`employee_party_id`), each with a composite tenant
-- foreign key (org_id, employment_id) → worker_employments(org_id, id):
--   employee_payroll_profiles, employee_pay_components,
--   employee_tax_certificates, pay_stubs, payroll_opening_balances,
--   entitlement_ledger, entitlement_plan_limits, payroll_retro_settlements,
--   pay_run_adjustments, pay_run_holiday_assertions.
-- timesheet_weeks / time_entries stay person-keyed by design (no column).
--
-- WHY NULLABLE WITH NO BACKFILL. Existing rows predate the HRM employment
-- record; fabricating an employment link at migration time would invent
-- history. The one-time backfill lives in the HRM→payroll resolver service
-- (engine/src/hrm/payroll-context.ts `stampEmploymentContext`), never here.
-- A null employment_id means "not yet stamped", never "no employment".
-- One table can never backfill by UPDATE: entitlement_ledger refuses every
-- UPDATE (entitlement_ledger_append_only_guard), so pre-0186 ledger rows keep
-- a null link and the stamp reports them as unstampable; new ledger rows
-- carry the link at INSERT under the trigger below.
--
-- ON DELETE SHAPE (deliberate 0184 parity, not an omission). The brief asks
-- for ON DELETE RESTRICT, deferrable, in the 0184/0185 tenant-coherent style.
-- PostgreSQL cannot defer RESTRICT: a RESTRICT check fires immediately even
-- on a DEFERRABLE constraint, which would pin whole-org teardown ordering
-- (the 0188 lesson). 0184 resolves the same conflict the same way — "deletes
-- are RESTRICTed (NO ACTION default)": no ON DELETE clause, DEFERRABLE
-- INITIALLY IMMEDIATE. NO ACTION refuses the delete of a referenced
-- employment exactly like RESTRICT, but the check defers to commit, so
-- governed teardown (which deletes children before parents inside one
-- transaction under openbooks.amend) keeps working. That is what is built
-- below; the integrator was told.
--
-- CROSS-ORG vs CROSS-PERSON (two guards, two jobs). The composite FK refuses
-- an employment_id from another org at commit (the (org_id, id) pair cannot
-- match). The `payroll_employment_coherence_guard()` trigger below refuses a
-- same-org employment that belongs to a DIFFERENT WORKER: it compares the
-- employment's worker_party_id against the row's employee_party_id and names
-- both ids. The FK cannot express that (it targets the employment, not the
-- worker). One shared function, one trigger per table — the predicate is
-- identical on all ten tables, so ten copies would be ten chances to drift.
-- An employment_id naming NO employment row at all falls through to the FK,
-- which refuses it at commit; the trigger does not duplicate that refusal.
-- A row with NO employee_party_id (non-person plan-limit scopes) abstains
-- here — there is nobody to compare against — and the scope CHECK below
-- owns that refusal with its precise message.
--
-- PARTIAL UNIQUE ON PROFILES. employee_payroll_profiles gains
-- UNIQUE (org_id, employment_id) WHERE employment_id IS NOT NULL: one
-- profile per employment once stamped. The legacy
-- UNIQUE (org_id, employee_party_id) stays: unstamped rows keep their
-- one-profile-per-person invariant, and a person with two employments keeps
-- two rows distinguishable until each is stamped.
--
-- PERSON-SCOPE CHECK ON PLAN LIMITS. entitlement_plan_limits rows exist at
-- plan, subsidiary, department, trade, job-title, AND person scope, but only
-- person-scope rows (employee_party_id IS NOT NULL) may carry employment_id.
-- The `entitlement_plan_limits_employment_scope` CHECK refuses any other
-- combination; NULL/NULL remains the valid unscoped shape.
--
-- PAY_STUBS SNAPSHOT GAP (documented for the payroll owner, not enforced
-- here). pay_stubs.employment_id is a snapshot: recalculation must never
-- re-resolve it from the live employment. Committed-run protection today
-- lives in the payroll service (engine/src/payroll-run.ts refuses
-- discard/recalculate/commit on committed runs) — there is NO storage-level
-- freeze on pay_stubs rows once pay_runs.run_status = 'committed' (the
-- 0091/0093 triggers guard country/filing-account snapshots, and the 0094 /
-- 0180 immutability guards cover pay_stub_lines, never pay_stubs). No SQL
-- guard in this slice's scope freezes pay_stubs, so this migration cannot
-- extend one; the payroll owner must include employment_id in whatever
-- commit-freeze they build. Until then a privileged SQL writer could rewrite
-- a committed stub's employment link — the coherence trigger would still
-- refuse a cross-person value, but not a same-person rewrite.
--
-- PARTY MERGES. Employment identity rows survive merges (worker_party_id is
-- re-pointed wholesale; the employment id never changes), so stamped
-- employment_id values stay valid across a merge with no re-pointing. The
-- new FKs target worker_employments, not parties(id), so the
-- party-merges live-schema guard (every FK to parties(id) covered) is
-- unaffected — proven by running it, not by adding lines.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Columns (nullable, no backfill, no default).
-- ---------------------------------------------------------------------------

ALTER TABLE public.employee_payroll_profiles ADD COLUMN employment_id uuid;
ALTER TABLE public.employee_pay_components ADD COLUMN employment_id uuid;
ALTER TABLE public.employee_tax_certificates ADD COLUMN employment_id uuid;
ALTER TABLE public.pay_stubs ADD COLUMN employment_id uuid;
ALTER TABLE public.payroll_opening_balances ADD COLUMN employment_id uuid;
ALTER TABLE public.entitlement_ledger ADD COLUMN employment_id uuid;
ALTER TABLE public.entitlement_plan_limits ADD COLUMN employment_id uuid;
ALTER TABLE public.payroll_retro_settlements ADD COLUMN employment_id uuid;
ALTER TABLE public.pay_run_adjustments ADD COLUMN employment_id uuid;
ALTER TABLE public.pay_run_holiday_assertions ADD COLUMN employment_id uuid;

-- ---------------------------------------------------------------------------
-- Composite tenant foreign keys (org coherence, 0184 pattern: NO ACTION
-- default = RESTRICT semantics, DEFERRABLE INITIALLY IMMEDIATE; see header).
-- ---------------------------------------------------------------------------

ALTER TABLE public.employee_payroll_profiles ADD CONSTRAINT employee_payroll_profiles_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.employee_pay_components ADD CONSTRAINT employee_pay_components_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.employee_tax_certificates ADD CONSTRAINT employee_tax_certificates_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.pay_stubs ADD CONSTRAINT pay_stubs_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.payroll_opening_balances ADD CONSTRAINT payroll_opening_balances_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.entitlement_ledger ADD CONSTRAINT entitlement_ledger_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.entitlement_plan_limits ADD CONSTRAINT entitlement_plan_limits_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.payroll_retro_settlements ADD CONSTRAINT payroll_retro_settlements_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.pay_run_adjustments ADD CONSTRAINT pay_run_adjustments_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.pay_run_holiday_assertions ADD CONSTRAINT pay_run_holiday_assertions_employment_tenant_fkey
  FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;

-- ---------------------------------------------------------------------------
-- Lookup indexes for the FK reverse direction and the stamp backfill.
-- ---------------------------------------------------------------------------

CREATE INDEX employee_payroll_profiles_employment ON public.employee_payroll_profiles(org_id, employment_id);
CREATE INDEX employee_pay_components_employment ON public.employee_pay_components(org_id, employment_id);
CREATE INDEX employee_tax_certificates_employment ON public.employee_tax_certificates(org_id, employment_id);
CREATE INDEX pay_stubs_employment ON public.pay_stubs(org_id, employment_id);
CREATE INDEX payroll_opening_balances_employment ON public.payroll_opening_balances(org_id, employment_id);
CREATE INDEX entitlement_ledger_employment ON public.entitlement_ledger(org_id, employment_id);
CREATE INDEX entitlement_plan_limits_employment ON public.entitlement_plan_limits(org_id, employment_id);
CREATE INDEX payroll_retro_settlements_employment ON public.payroll_retro_settlements(org_id, employment_id);
CREATE INDEX pay_run_adjustments_employment ON public.pay_run_adjustments(org_id, employment_id);
CREATE INDEX pay_run_holiday_assertions_employment ON public.pay_run_holiday_assertions(org_id, employment_id);

-- One profile per employment once stamped; the legacy per-person unique stays.
CREATE UNIQUE INDEX employee_payroll_profiles_employment_unique
  ON public.employee_payroll_profiles(org_id, employment_id)
  WHERE (employment_id IS NOT NULL);

-- Only person-scope plan-limit rows may carry an employment link.
ALTER TABLE public.entitlement_plan_limits ADD CONSTRAINT entitlement_plan_limits_employment_scope CHECK (
  (employment_id IS NULL) OR (employee_party_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Coherence trigger: the employment must belong to the row's worker.
-- Shared function (identical predicate on all ten tables), one trigger per
-- table. Fires on INSERT and on UPDATE of either linked column, so neither
-- side of the pair can be re-pointed past the other.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.payroll_employment_coherence_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE worker uuid;
BEGIN
  IF NEW.employment_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- No person on the row (entitlement_plan_limits non-person scopes): there
  -- is nobody to compare the employment against, so this guard abstains and
  -- the scope CHECK owns the refusal with its precise message.
  IF NEW.employee_party_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT we.worker_party_id INTO worker
    FROM public.worker_employments we
   WHERE we.org_id = NEW.org_id AND we.id = NEW.employment_id;
  -- No row (yet): the composite FK refuses unknown/other-org ids at commit.
  -- This trigger owns only the cross-person refusal, which the FK cannot see.
  IF worker IS NULL THEN
    RETURN NEW;
  END IF;
  IF worker IS DISTINCT FROM NEW.employee_party_id THEN
    RAISE EXCEPTION
      '% employment_id % names an employment of worker %, not employee % — stamp the row with an employment of the row''s own worker',
      TG_TABLE_NAME, NEW.employment_id, worker, NEW.employee_party_id;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.payroll_employment_coherence_guard() IS
  'Payroll employment coherence (0186): refuses any payroll row whose employment_id names an employment of a different worker. Cross-org/unknown ids are the composite tenant FK''s job at commit; this trigger owns only the cross-person refusal and names both ids.';

CREATE TRIGGER employee_payroll_profiles_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.employee_payroll_profiles
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER employee_pay_components_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.employee_pay_components
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER employee_tax_certificates_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.employee_tax_certificates
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER pay_stubs_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.pay_stubs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER payroll_opening_balances_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.payroll_opening_balances
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER entitlement_ledger_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.entitlement_ledger
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER entitlement_plan_limits_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.entitlement_plan_limits
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER payroll_retro_settlements_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.payroll_retro_settlements
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER pay_run_adjustments_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.pay_run_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
CREATE TRIGGER pay_run_holiday_assertions_employment_coherence BEFORE INSERT OR UPDATE OF employment_id, employee_party_id ON public.pay_run_holiday_assertions
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employment_coherence_guard();
