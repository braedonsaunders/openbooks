-- Consolidate project classification onto the governed project_type_id FK
-- (-> project_types, which carries the profitability/invoicing/backup profiles)
-- and drop the legacy coarse `billing_method` column. This app is pre-launch, so
-- there is no back-compat to preserve: project_type_id is the single source of
-- truth, and code that needs the coarse value derives it from the project's type
-- (project_types.billing_method), defaulting to Time & Materials when a project
-- has no type yet (e.g. an unconfigured draft).

-- Backfill: an unclassified project inherits the type whose key matches its coarse
-- billing_method (the three coarse values -- time_and_materials / fixed_price /
-- cost_plus -- are all project_type keys).
update projects p
   set project_type_id = pt.id
  from project_types pt
 where p.project_type_id is null
   and p.billing_method is not null
   and pt.org_id = p.org_id
   and pt.key = p.billing_method;

alter table projects drop column if exists billing_method;
