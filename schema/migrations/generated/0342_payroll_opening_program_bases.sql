-- OpenBooks forward migration 0342_payroll_opening_program_bases.
--
-- C-13: a mid-year adopter's pre-adoption QPIP-insurable earnings had nowhere
-- to live. `payroll_opening_balances.insurable_ytd` is the EI base, so T4 box
-- 56 and RL-1 box I (the QPIP program's OWN base, capped at the QPIP maximum)
-- excluded everything earned before adoption. The fix is a per-program
-- carry-in, and it is GENERIC: packs declare contribution programs
-- (`PayrollContributionProgram` in engine/src/payroll/packs.ts — today only
-- the CA pack's `qpip`), while the core schema stays country-neutral. A
-- `qpip_insurable_ytd` column on the shared table would bake one Canadian
-- program into every country's carry-in, so the base lives in a sidecar keyed
-- by the pack-declared program key instead.
--
-- Two changes:
--
-- (a) New table payroll_opening_program_bases: one insurable-earnings
--     year-to-date per (org, employee, tax year, program key). A foreign key
--     to the parent carry-in row (ON DELETE CASCADE) keeps "one carry-in per
--     employee per year" singular: the lock, the audit trail and the
--     all-zero-is-a-delete rule all keep working through the parent, and a
--     program-only carry-in still creates its parent row. Amounts are
--     non-negative money; a program key nobody declares is stored but never
--     read (the same inert-key rule as pay component tax treatments).
-- (b) pay_components.program_exclusions: the per-earning-type half of the
--     same defect. A component lists the program keys its earnings do NOT
--     contribute to (empty = contributes to every declared program, matching
--     the sibling flags' default-true). The stub builders stamp exclusions
--     onto lines as false entries, so an earning type that is EI-excluded
--     but QPIP-insurable — or the reverse — accumulates each program's own
--     base. Undeclared keys are inert on runs, exactly like an undeclared
--     tax treatment.
--
-- Re-runnable: table, column, constraints and policy are IF NOT EXISTS /
-- existence-guarded; replay changes nothing. No backfill: pre-0342 stubs
-- carry no per-program factor, and the slip readers fall back to the single
-- legacy base those stubs were priced off (the record, not an
-- approximation), so nothing stored needs rewriting.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS public.payroll_opening_program_bases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  employee_party_id uuid NOT NULL,
  tax_year integer NOT NULL,
  program_key text NOT NULL,
  insurable_ytd numeric(19,4) NOT NULL DEFAULT '0',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payroll_opening_program_bases_employee_year_program_unique
    UNIQUE (org_id, employee_party_id, tax_year, program_key),
  CONSTRAINT payroll_opening_program_bases_parent_fk
    FOREIGN KEY (org_id, employee_party_id, tax_year)
    REFERENCES public.payroll_opening_balances (org_id, employee_party_id, tax_year)
    ON DELETE CASCADE,
  CONSTRAINT payroll_opening_program_bases_program_key CHECK (program_key <> ''),
  CONSTRAINT payroll_opening_program_bases_nonnegative CHECK (insurable_ytd >= 0)
);
CREATE INDEX IF NOT EXISTS payroll_opening_program_bases_year_lookup
  ON public.payroll_opening_program_bases (org_id, tax_year, employee_party_id);

ALTER TABLE ONLY public.payroll_opening_program_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.payroll_opening_program_bases FORCE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'payroll_opening_program_bases' AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.payroll_opening_program_bases
      USING ((current_setting('app.bypass_rls', true) = 'on') OR (org_id::text = current_setting('app.current_org', true)))
      WITH CHECK ((current_setting('app.bypass_rls', true) = 'on') OR (org_id::text = current_setting('app.current_org', true)));
  END IF;
END;
$policy$;

COMMENT ON TABLE public.payroll_opening_program_bases IS 'Per-program insurable-earnings carry-in for mid-year adopters (0342, C-13): one year-to-date per pack-declared contribution program key. Child of payroll_opening_balances by (org, employee, year) with cascade; the lock, audit and all-zero-delete rules stay on the parent.';
COMMENT ON COLUMN public.payroll_opening_program_bases.program_key IS 'Contribution program key declared by the country pack (PayrollContributionProgram.key, e.g. qpip). A key no pack declares is stored but never read.';
COMMENT ON COLUMN public.payroll_opening_program_bases.insurable_ytd IS 'Pre-adoption earnings insurable under this program (e.g. the T4 box 56 / RL-1 box I source). Folds into the program base and is capped at the program maximum with the committed stubs.';

-- Per-earning-type program applicability: program keys this component's
-- earnings do NOT contribute to. Empty (the default) contributes to every
-- declared program. Undeclared keys are inert on runs.
ALTER TABLE public.pay_components
  ADD COLUMN IF NOT EXISTS program_exclusions text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.pay_components.program_exclusions IS 'Contribution program keys (PayrollContributionProgram.key) this component does NOT feed (0342, C-13). Empty means every declared program. Undeclared keys are inert, like an undeclared tax treatment.';
