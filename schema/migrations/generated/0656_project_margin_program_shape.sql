-- Project-margin incentives pay a percentage of each project's margin to the
-- project's responsible manager through payroll, measured company-wide.
ALTER TABLE public.hrm_benefit_programs DROP CONSTRAINT hrm_benefit_programs_transaction_shape;
ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_transaction_shape CHECK(
 (coalesce(metric='transactions',false) AND valuation IN ('percent','per_unit') AND allocation='responsibility' AND metric_scope='company'
  AND family IN ('incentive','custom') AND delivery_method='payroll'
  AND cap_amount IS NULL AND threshold_amount IS NULL AND budget_amount IS NULL
  AND ((valuation='percent' AND percent_rate IS NOT NULL AND percent_rate>0) OR (valuation='per_unit' AND fixed_amount IS NOT NULL AND fixed_amount>0)))
 OR (coalesce(metric='project_margin',false) AND valuation='percent' AND allocation='responsibility' AND metric_scope='company'
  AND family='incentive' AND delivery_method='payroll'
  AND cap_amount IS NULL AND threshold_amount IS NULL AND budget_amount IS NULL
  AND percent_rate IS NOT NULL AND percent_rate>0)
 OR ((metric IS NULL OR metric NOT IN ('transactions','project_margin')) AND valuation<>'per_unit' AND allocation<>'responsibility')
 OR (coalesce(metric='approved_hours',false) AND valuation='per_unit' AND allocation='hours'
  AND family='incentive' AND delivery_method='payroll' AND percent_rate IS NULL
  AND fixed_amount IS NOT NULL AND fixed_amount>0));
