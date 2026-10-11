-- Project-margin incentives share each project's lifetime margin once, when it
-- first earns revenue: a profit rate on gains and a loss rate on losses,
-- capped per project, paid to the project manager or the manager's team by
-- membership weight. Programs choose whether open purchase commitments count
-- as cost and whether a project's pool rounds before it is shared. Scope rows
-- may exclude named projects from an otherwise company-wide program.
ALTER TABLE public.hrm_benefit_programs DROP CONSTRAINT IF EXISTS hrm_benefit_programs_metric;
ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_metric CHECK (
  metric IS NULL OR metric IN ('revenue','gross_profit','net_profit','approved_hours','transactions','project_margin'));
ALTER TABLE public.hrm_benefit_programs
  ADD COLUMN IF NOT EXISTS loss_percent_rate numeric(9,4),
  ADD COLUMN IF NOT EXISTS project_profit_cap numeric(19,4),
  ADD COLUMN IF NOT EXISTS project_loss_cap numeric(19,4),
  ADD COLUMN IF NOT EXISTS pool_rounding text DEFAULT 'share' NOT NULL,
  ADD COLUMN IF NOT EXISTS include_open_commitments boolean DEFAULT false NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_programs_project_margin_terms') THEN
    ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_project_margin_terms CHECK (
      (loss_percent_rate IS NULL OR (loss_percent_rate >= 0 AND loss_percent_rate <= 100))
      AND (project_profit_cap IS NULL OR project_profit_cap >= 0)
      AND (project_loss_cap IS NULL OR project_loss_cap >= 0)
      AND pool_rounding IN ('share','pool')); END IF;
END $$;

ALTER TABLE public.hrm_benefit_program_scopes ADD COLUMN IF NOT EXISTS excluded boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.hrm_benefit_programs.loss_percent_rate IS 'Project-margin programs: percent of a project loss charged to its recipients; null shares no losses.';
COMMENT ON COLUMN public.hrm_benefit_programs.project_profit_cap IS 'Project-margin programs: largest pool one project can pay.';
COMMENT ON COLUMN public.hrm_benefit_programs.project_loss_cap IS 'Project-margin programs: largest loss one project can charge.';
COMMENT ON COLUMN public.hrm_benefit_programs.pool_rounding IS 'share rounds each recipient share from the exact pool; pool rounds the pool first.';
COMMENT ON COLUMN public.hrm_benefit_programs.include_open_commitments IS 'Project-margin programs: open purchase-order commitments count as project cost.';
COMMENT ON COLUMN public.hrm_benefit_program_scopes.excluded IS 'The scoped project is excluded from an otherwise wider measurement.';
