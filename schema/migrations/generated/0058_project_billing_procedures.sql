-- Projects owns every project-accounting and project-billing capability.
-- Construction-style progress billing is migrated from an independent feature
-- switch to an explicit project-type billing procedure.

-- Make the procedure discriminator explicit on every existing profile without
-- changing any tenant-selected billing behavior.
update project_types
   set invoicing_profile = jsonb_set(invoicing_profile, '{billingProcedure}', '"standard"'::jsonb, true),
       updated_at = now()
 where not (invoicing_profile ? 'billingProcedure');

-- Add the controlled Schedule-of-Values profile for every existing tenant.
-- Tenant-owned rows with the same stable key win.
insert into project_types (
  org_id, key, name, description, is_built_in, is_active, sort_order,
  billing_method, financial_profile, invoicing_profile, backup_profile
)
select
  o.id,
  'schedule_of_values',
  'Schedule of Values',
  'Bill a fixed-price contract through cumulative applications for payment, change orders, and retainage.',
  true,
  true,
  50,
  'fixed_price',
  '{
    "invoicedToDate":{"docKinds":["customer_invoice"],"creditKinds":["customer_credit"]},
    "actualCost":{"source":"account_types","accountTypes":["expense","cogs","expense_other","expense_deferred"]},
    "laborCost":{"source":"in_actual_cost"},
    "overhead":{"method":"none"},
    "committedCost":{"docKinds":["purchase_order"]},
    "billableValue":{"includeUnbilledTime":true,"includeUnbilledCostLines":true,"timeRate":"bill_rate"},
    "costBudget":{"source":"wbs_estimates"},
    "totalPrice":{"method":"contract_field"},
    "couldBeInvoiced":{"formula":"price_minus_invoiced"},
    "totalCost":{"components":["actual_cost","committed_cost"]},
    "layout":[
      {"measure":"invoiced_to_date","variant":"line"},
      {"measure":"could_be_invoiced","variant":"line"},
      {"measure":"total_price","variant":"subtotal"},
      {"measure":"actual_cost","variant":"line"},
      {"measure":"committed_cost","variant":"line"},
      {"measure":"total_cost","variant":"subtotal"},
      {"measure":"cost_budget","variant":"line"},
      {"measure":"remaining_budget","variant":"line"},
      {"measure":"gross_profit","variant":"total"}
    ]
  }'::jsonb,
  '{
    "billingProcedure":"application_for_payment",
    "allowedBases":["draw_amount"],
    "defaultBasis":"draw_amount",
    "lineBuilder":"draw",
    "revenueAccount":"item_income",
    "recognition":"as_invoiced"
  }'::jsonb,
  '{"required":false,"defaultBackupType":"none","allowedBackupTypes":["none","quote_only"]}'::jsonb
from orgs o
on conflict (org_id, key) do nothing;

-- Preserve the deprecated child setting as migration evidence while removing
-- it from the effective feature namespace. The Projects parent gate is now the
-- only organization-level policy.
update orgs
   set settings = jsonb_set(
     coalesce(settings, '{}'::jsonb) #- '{features,constructionBilling}',
     '{legacyFeatureSettings}',
     coalesce(settings->'legacyFeatureSettings', '{}'::jsonb)
       || jsonb_build_object('constructionBilling', settings->'features'->'constructionBilling'),
     true
   )
 where coalesce(settings->'features', '{}'::jsonb) ? 'constructionBilling';
