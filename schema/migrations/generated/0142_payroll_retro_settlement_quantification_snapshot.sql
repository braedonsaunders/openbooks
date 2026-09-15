-- OpenBooks forward migration 0142_payroll_retro_settlement_quantification_snapshot.
--
-- A retro settlement's recomputed numbers are priced from the inputs as they
-- stand at QUANTIFICATION time, but readiness compared the live inputs against
-- the SOURCE run's own (older) calculation snapshot. A time correction made
-- after the source run was calculated yet before the retro was quantified was
-- therefore already inside the settlement's recomputed earnings AND still read
-- as `time_moved`, blocking a legitimate retro run with a `retro.stale`
-- finding no operator action could ever clear.
--
-- Additive, ledger-tracked, no history reinterpretation: one nullable jsonb
-- column carrying the exact calculation population the quantification
-- simulation priced in (the `payRunCalculationSource` shape: time entries,
-- time types, pay rates, claim entry ids). Rows written before this migration
-- keep NULL and read exactly as before, falling back to the source run's
-- snapshot; rows written after carry their own baseline.
ALTER TABLE public.payroll_retro_settlements
  ADD COLUMN IF NOT EXISTS quantified_source_snapshot jsonb;

COMMENT ON COLUMN public.payroll_retro_settlements.quantified_source_snapshot IS
  'Calculation population (time entries, time types, pay rates, claim entry ids) as the quantification simulation saw it. Readiness compares live inputs against this snapshot, not the source run''s older one, so a correction that predates quantification — already priced into recomputed_earnings — does not read as stale. NULL on rows written before migration 0142, which fall back to the source run snapshot.';
