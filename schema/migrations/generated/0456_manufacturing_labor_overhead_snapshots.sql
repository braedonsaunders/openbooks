-- OpenBooks forward migration 0456_manufacturing_labor_overhead_snapshots.
-- Freeze release-time standard-labor, FX, and overhead facts on work-order
-- operations. Every new column is nullable: rows released before this upgrade
-- keep all eighteen null and are refused by name on the variance and close
-- paths (owned downstream), never priced as zero. The release writer fills
-- the groups at once; the coherence checks below refuse a torn group, and
-- the immutability trigger refuses any later change to a written value.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Release-frozen standard-labor group (10): the resolved wage row and its
-- effective date, the raw source rate with denomination/basis/year divisor,
-- the burden-inclusive functional hourly rate with denomination, and the
-- burden document with its hash. Copied at release so later rate, burden, or
-- currency edits can never reinterpret a released operation.
ALTER TABLE public.mfg_wo_operations
  ADD COLUMN standard_labor_wage_id uuid,
  ADD COLUMN standard_labor_effective_from date,
  ADD COLUMN standard_labor_rate numeric(19,4),
  ADD COLUMN standard_labor_currency char(3),
  ADD COLUMN standard_labor_basis text,
  ADD COLUMN standard_labor_annual_hours numeric(19,4),
  ADD COLUMN standard_labor_final_rate numeric(19,4),
  ADD COLUMN standard_labor_functional_currency char(3),
  ADD COLUMN standard_labor_burden jsonb,
  ADD COLUMN standard_labor_burden_hash text;

-- Release-frozen FX group (6): explicit frozen evidence, never an inferred
-- live quote. Same-currency operations freeze class 'par' with rate 1 and no
-- row/date/source/direction; foreign operations freeze class 'quoted' with
-- the quoted row, date, source, and direction.
ALTER TABLE public.mfg_wo_operations
  ADD COLUMN standard_labor_fx_class text,
  ADD COLUMN standard_labor_fx_rate numeric(19,10),
  ADD COLUMN standard_labor_fx_row_id uuid,
  ADD COLUMN standard_labor_fx_date date,
  ADD COLUMN standard_labor_fx_source text,
  ADD COLUMN standard_labor_fx_direction text;

-- Release-frozen overhead group (2): the canonical selected-card evidence
-- document carrying all selected row ids, effective dates, kinds,
-- categories, and rates, plus its tamper hash recomputed from the stored
-- JSON only.
ALTER TABLE public.mfg_wo_operations
  ADD COLUMN overhead_snapshot jsonb,
  ADD COLUMN overhead_snapshot_hash text;

-- Tenant-safe labor-rate parent: the (org_id, id) anchor the frozen wage
-- reference points at. Implied by the id primary key, so no backfill.
ALTER TABLE ONLY public.labor_cost_rates
  ADD CONSTRAINT labor_cost_rates_org_id_id_unique UNIQUE (org_id, id);

-- The frozen wage reference. The remaining snapshot id columns carry frozen
-- lineage without a database foreign key: the live rate rows are
-- effective-dated and superseded over time, and a frozen copy must never
-- couple to live configuration.
ALTER TABLE ONLY public.mfg_wo_operations
  ADD CONSTRAINT mfg_wo_operations_standard_labor_wage_fk
    FOREIGN KEY (org_id, standard_labor_wage_id)
    REFERENCES public.labor_cost_rates(org_id, id) ON DELETE RESTRICT DEFERRABLE;
CREATE INDEX mfg_wo_operations_standard_labor_wage_idx
  ON public.mfg_wo_operations(org_id, standard_labor_wage_id);

-- The stored job-costing bases: the two historical kinds plus the two
-- manufacturing kinds. Existing unknown kinds are refused by the 0456
-- preflight before this constraint lands.
ALTER TABLE ONLY public.overhead_rates
  ADD CONSTRAINT overhead_rates_rate_kind_allowed
    CHECK (rate_kind IN ('per_hour', 'percent', 'per_unit', 'per_machine_hour'));

-- Coherence: the labor group is absent together (legacy) or complete
-- together; a partial group is a torn write, not a priceable state.
ALTER TABLE ONLY public.mfg_wo_operations
  ADD CONSTRAINT mfg_woop_std_labor_coherent CHECK (
    num_nonnulls(standard_labor_wage_id, standard_labor_effective_from,
      standard_labor_rate, standard_labor_currency, standard_labor_basis,
      standard_labor_annual_hours, standard_labor_final_rate,
      standard_labor_functional_currency, standard_labor_burden,
      standard_labor_burden_hash) IN (0, 10));

-- Coherence: the FX group is absent together (legacy), an explicit par with
-- rate 1 and no quote evidence, or a complete quoted conversion. A null
-- group never means "no conversion".
ALTER TABLE ONLY public.mfg_wo_operations
  ADD CONSTRAINT mfg_woop_std_fx_coherent CHECK (
    num_nonnulls(standard_labor_fx_class, standard_labor_fx_rate,
      standard_labor_fx_row_id, standard_labor_fx_date,
      standard_labor_fx_source, standard_labor_fx_direction) = 0
    OR (standard_labor_fx_class = 'par'
        AND standard_labor_fx_rate = 1
        AND standard_labor_fx_row_id IS NULL
        AND standard_labor_fx_date IS NULL
        AND standard_labor_fx_source IS NULL
        AND standard_labor_fx_direction IS NULL)
    OR (standard_labor_fx_class = 'quoted'
        AND standard_labor_fx_rate IS NOT NULL
        AND standard_labor_fx_row_id IS NOT NULL
        AND standard_labor_fx_date IS NOT NULL
        AND standard_labor_fx_source IS NOT NULL
        AND standard_labor_fx_direction IS NOT NULL));

-- Coherence: the overhead document and its hash are absent together
-- (legacy) or present together.
ALTER TABLE ONLY public.mfg_wo_operations
  ADD CONSTRAINT mfg_woop_ovhd_coherent CHECK (
    num_nonnulls(overhead_snapshot, overhead_snapshot_hash) IN (0, 2));

-- Immutability: release snapshots are written once by INSERT inside the
-- release transaction; any refusal rolls the whole transaction back. No
-- draft/null UPDATE path exists, so this guard refuses EVERY later change
-- to any snapshot column on UPDATE — including null to value. Legacy
-- all-null operations stay null and refuse by name downstream; they can
-- never be backfilled from current configuration.
CREATE FUNCTION public.mfg_wo_snapshot_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS
$fn$
BEGIN
  IF (NEW.standard_labor_wage_id IS DISTINCT FROM OLD.standard_labor_wage_id)
    OR (NEW.standard_labor_effective_from IS DISTINCT FROM OLD.standard_labor_effective_from)
    OR (NEW.standard_labor_rate IS DISTINCT FROM OLD.standard_labor_rate)
    OR (NEW.standard_labor_currency IS DISTINCT FROM OLD.standard_labor_currency)
    OR (NEW.standard_labor_basis IS DISTINCT FROM OLD.standard_labor_basis)
    OR (NEW.standard_labor_annual_hours IS DISTINCT FROM OLD.standard_labor_annual_hours)
    OR (NEW.standard_labor_final_rate IS DISTINCT FROM OLD.standard_labor_final_rate)
    OR (NEW.standard_labor_functional_currency IS DISTINCT FROM OLD.standard_labor_functional_currency)
    OR (NEW.standard_labor_burden IS DISTINCT FROM OLD.standard_labor_burden)
    OR (NEW.standard_labor_burden_hash IS DISTINCT FROM OLD.standard_labor_burden_hash)
    OR (NEW.standard_labor_fx_class IS DISTINCT FROM OLD.standard_labor_fx_class)
    OR (NEW.standard_labor_fx_rate IS DISTINCT FROM OLD.standard_labor_fx_rate)
    OR (NEW.standard_labor_fx_row_id IS DISTINCT FROM OLD.standard_labor_fx_row_id)
    OR (NEW.standard_labor_fx_date IS DISTINCT FROM OLD.standard_labor_fx_date)
    OR (NEW.standard_labor_fx_source IS DISTINCT FROM OLD.standard_labor_fx_source)
    OR (NEW.standard_labor_fx_direction IS DISTINCT FROM OLD.standard_labor_fx_direction)
    OR (NEW.overhead_snapshot IS DISTINCT FROM OLD.overhead_snapshot)
    OR (NEW.overhead_snapshot_hash IS DISTINCT FROM OLD.overhead_snapshot_hash)
  THEN
    RAISE EXCEPTION 'operation % for work order % carries release-frozen snapshots that cannot be rewritten; correct through reversal or an adjusting entry', NEW.id, NEW.work_order_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mfg_wo_snapshot_immutable
  BEFORE UPDATE ON public.mfg_wo_operations
  FOR EACH ROW EXECUTE FUNCTION public.mfg_wo_snapshot_immutable_guard();

-- No new tables, so no catalog relation registration; refresh column metadata.
SELECT public.openbooks_refresh_query_catalog();
