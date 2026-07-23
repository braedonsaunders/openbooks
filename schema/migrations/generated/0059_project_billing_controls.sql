-- Forward-only controls for the Projects-owned Applications for Payment model.
-- This migration intentionally does not rewrite 0058 after deployment.

-- "Invoiced" means the approved application generated its controlled draft
-- customer invoice. "Posted" remains accepted only for backward compatibility.
alter table pay_applications drop constraint if exists pay_applications_status;
alter table pay_applications
  add constraint pay_applications_status
  check (status in ('draft', 'submitted', 'approved', 'invoiced', 'posted', 'void'));

update pay_applications
   set status = 'invoiced', updated_at = now()
 where status = 'posted' and invoice_document_id is not null;

-- Preserve distinct preparer, submitter, and approver evidence. These are
-- deliberately explicit rather than inferred from mutable audit columns.
alter table pay_applications
  add column if not exists submitted_at timestamptz,
  add column if not exists submitted_by uuid,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid;
alter table change_orders
  add column if not exists approved_by uuid;

create unique index if not exists pay_applications_one_open_per_project
  on pay_applications (org_id, project_id)
  where status in ('draft', 'submitted', 'approved');

-- Database-level financial bounds backstop API and service validation.
alter table sov_lines
  add constraint sov_lines_value_nonnegative check (scheduled_value >= 0) not valid,
  add constraint sov_lines_retainage_range check (retainage_percent is null or retainage_percent between 0 and 100) not valid;
alter table pay_applications
  add constraint pay_applications_retainage_range check (retainage_percent between 0 and 100) not valid;
alter table pay_application_lines
  add constraint pay_application_lines_draw_nonnegative
  check (previous_completed >= 0 and this_period_completed >= 0 and materials_stored >= 0) not valid;

alter table sov_lines validate constraint sov_lines_value_nonnegative;
alter table sov_lines validate constraint sov_lines_retainage_range;
alter table pay_applications validate constraint pay_applications_retainage_range;
alter table pay_application_lines validate constraint pay_application_lines_draw_nonnegative;

-- The project type is the single source of truth for billing procedure. An
-- application-for-payment profile cannot drift away from draw billing.
alter table project_types
  add constraint project_types_billing_procedure_control
  check (
    invoicing_profile->>'billingProcedure' = 'standard'
    or (
      invoicing_profile->>'billingProcedure' = 'application_for_payment'
      and billing_method = 'fixed_price'
      and invoicing_profile->'allowedBases' = '["draw_amount"]'::jsonb
      and invoicing_profile->>'defaultBasis' = 'draw_amount'
      and invoicing_profile->>'lineBuilder' = 'draw'
    )
  ) not valid;
alter table project_types validate constraint project_types_billing_procedure_control;

-- System-authored audit evidence for the prior configuration migration. The
-- migration runner supplies exactly-once execution; actor_id is null by design.
insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
select o.id, 'orgs', o.id, 'configuration_migration',
       jsonb_build_object(
         'migration', '0058_project_billing_procedures',
         'before', jsonb_build_object('constructionBilling', o.settings->'legacyFeatureSettings'->'constructionBilling'),
         'after', jsonb_build_object('projectsParentGate', coalesce((o.settings->'features'->>'projects')::boolean, true),
                                    'constructionBillingFeatureRemoved', true)
       ),
       null
  from orgs o;

insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
select pt.org_id, 'project_types', pt.id, 'configuration_migration',
       jsonb_build_object(
         'migration', '0058_project_billing_procedures',
         'after', jsonb_build_object('key', pt.key, 'billingProcedure', pt.invoicing_profile->>'billingProcedure')
       ),
       null
  from project_types pt
 where pt.key = 'schedule_of_values';
