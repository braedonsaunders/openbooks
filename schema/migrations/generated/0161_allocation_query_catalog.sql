-- OpenBooks forward migration 0161_allocation_query_catalog.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Migration 0160 replaced the dormant planning-era allocation tables with the
-- kernel model (rule versions, drivers, driver values, runs, lineage) and
-- stamped document_lines (distribution_*) and journal_lines
-- (contributor_kind/ref). It deliberately left the governed query catalog
-- alone; this migration widens it:
--
-- - public.openbooks_refresh_query_catalog() gains the four new kernel
--   tables in safe_relations (the three replaced names were already listed),
--   following 0070's pattern, so every future catalog rebuild exposes them;
-- - the seven kernel views are (re)created and granted now — 0160 dropped
--   the three replaced views, and the four new tables never had views — so
--   no later full refresh is required for the catalog to expose the kernel;
-- - openbooks_query.journal_lines and openbooks_query.document_lines are
--   rebuilt with explicit column lists carrying the new stamps.
--
-- Re-create rather than replace those two views: an installation whose views
-- were frozen by an older refresh lists their columns in a different order
-- than a fresh bootstrap, and CREATE OR REPLACE VIEW refuses to reorder
-- columns ("cannot change name of view column"). Nothing depends on these
-- views, and the read role's grant is restored explicitly below each
-- rebuild (0158 precedent). No posted history is reinterpreted.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.openbooks_refresh_query_catalog() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
declare
  relation_name text;
  has_org_id boolean;
  global_relations constant text[] := array['currencies'];
  safe_relations constant text[] := array[
    'account_group_members', 'account_groups', 'accounting_books',
    'accounting_periods', 'accounts', 'addresses', 'allocation_driver_values',
    'allocation_drivers', 'allocation_lineage', 'allocation_rule_targets',
    'allocation_rule_versions', 'allocation_rules', 'allocation_runs', 'applications', 'asset_categories',
    'asset_events', 'bank_match_rules', 'bank_statement_lines', 'bank_statements',
    'billing_request_field_tickets', 'billing_requests', 'billing_schedules',
    'bom_components', 'budget_lines', 'budget_scenarios', 'cam_allocations',
    'cam_pools', 'change_orders',
    'charge_rate_components', 'classes', 'close_automation_executions',
    'close_events', 'close_exceptions', 'close_reopen_requests',
    'close_reporting_packages', 'close_run_tasks', 'close_runs', 'close_signoffs',
    'close_task_evidence', 'compliance_classes', 'compliance_records',
    'compliance_release_checks', 'compliance_requirements', 'compliance_waivers',
    'consolidated_fx_rates', 'contacts', 'cost_layer_consumptions',
    'cost_layer_weights', 'cost_layers', 'crm_account_assignment_events',
    'crm_account_profiles', 'crm_account_stage_events', 'crm_account_statuses',
    'crm_activity_links', 'crm_activity_participants',
    'crm_forecast_snapshots', 'crm_lead_sources', 'crm_opportunities',
    'crm_opportunity_documents', 'crm_opportunity_lines',
    'crm_opportunity_stage_events', 'crm_opportunity_statuses',
    'crm_opportunity_team_members', 'crm_sales_quotas', 'crm_sales_team_members',
    'crm_sales_teams', 'crm_sales_territories', 'currencies', 'departments',
    'depreciation_book_policies', 'depreciation_inputs', 'depreciation_methods',
    'depreciation_schedule_lines', 'depreciation_schedules',
    'document_line_tax_components', 'document_lines', 'document_links', 'documents',
    'dunning_log', 'entitlement_ledger',
    'entitlement_plan_limits', 'entitlement_plans', 'entitlement_service_tiers',
    'equipment_units', 'fair_value_prices',
    'field_ticket_labor_lines', 'field_ticket_labor_snapshots',
    'field_ticket_signatures', 'field_tickets', 'fiscal_calendars', 'fixed_assets',
    'fx_rates', 'gl_month_activity', 'income_tax_rates', 'intercompany_pairs',
    'inventory_movements',
    'inventory_provisional_costs', 'inventory_provisional_settlements',
    'invoice_backups', 'item_inventory_profiles', 'item_rate_book_assignments',
    'item_rate_books', 'item_rate_lines', 'item_rate_profiles', 'item_rate_versions',
    'items', 'journal_entries', 'journal_lines', 'labor_cost_rates',
    'labor_rate_adjustment_targets', 'labor_rate_adjustments', 'labor_rate_terms',
    'labor_rate_version_policies', 'labor_rate_version_scopes',
    'landed_cost_allocations', 'landed_cost_voucher_targets', 'landed_cost_vouchers',
    'lease_charges', 'lease_escalations', 'lease_schedule_lines', 'lien_waivers',
    'locations', 'lots', 'managed_properties', 'overhead_rates',
    'ownership_consolidation_entries', 'ownership_consolidation_runs',
    'party_subsidiaries', 'pay_application_lines', 'pay_applications',
    'payment_events', 'payment_remittances', 'payment_run_items', 'payment_runs',
    'payment_schedules', 'payment_settlements', 'payment_surcharge_rules',
    'payment_terms', 'performance_obligations', 'period_locks',
    'project_financial_adjustments', 'project_financial_profile_versions',
    'project_overhead_adjustments', 'project_tasks', 'project_types', 'projects',
    'property_leases', 'property_units',
    'recognition_rules', 'recognition_schedule_lines', 'recognition_schedules',
    'reconciliation_matches', 'reconciliations', 'recurring_schedules',
    'revenue_contracts', 'schedule_baseline_tasks', 'schedule_baselines',
    'schedule_calendars', 'schedule_dependencies', 'schedule_resources',
    'schedule_task_assignments', 'security_deposit_transactions',
    'segment_definitions', 'segment_values', 'serials',
    'sov_lines', 'stock_count_lines', 'stock_counts', 'stock_locations',
    'subcontract_change_orders', 'subcontract_payment_controls',
    'subcontract_sov_lines', 'subcontracts', 'subscription_amendments',
    'subscription_components', 'subscription_events', 'subscription_lifecycles',
    'subscription_period_invoices', 'subscription_plan_version_components',
    'subscription_plan_versions', 'subscription_plans', 'subscriptions',
    'subsidiary_ownership_interests', 'tax_codes', 'tax_country_pack_installations',
    'tax_depreciation_pools', 'tax_filings', 'tax_first_year_rules',
    'tax_groups', 'tax_jurisdictions', 'tax_locale_pack_meta',
    'tax_pool_classes', 'tax_pool_periods', 'tax_provision_runs', 'tax_rates',
    'tax_regimes', 'tax_registrations', 'tax_report_lines', 'tax_return_forms',
    'temporary_differences', 'time_types', 'timesheet_weeks',
    'trades',
    'transfer_order_lines', 'transfer_orders', 'vendor_pay_application_lines',
    'vendor_pay_applications', 'vendor_retainage_releases', 'wip_holds',
    'wip_prebill_events', 'wip_prebill_lines', 'wip_prebills', 'worker_comp_groups',
    'employee_pay_components',
    'pay_components', 'pay_derived_rules', 'pay_run_adjustments', 'pay_runs',
    'pay_schedules', 'pay_stub_lines', 'pay_stubs',
    'payroll_filing_accounts', 'payroll_holidays',
    'payroll_opening_balance_components', 'payroll_opening_balances',
    'union_agreements', 'union_classifications',
    'union_fringes'
  ];
begin
  -- Public base tables are never query-console surfaces. Revoke both current
  -- and future access before rebuilding the reviewed view catalog.
  revoke all privileges on all tables in schema public from openbooks_read;
  alter default privileges in schema public revoke select on tables from openbooks_read;

  drop schema if exists openbooks_query cascade;
  create schema openbooks_query;
  revoke all on schema openbooks_query from public;
  grant usage on schema openbooks_query to openbooks_read;

  foreach relation_name in array safe_relations loop
    if to_regclass(format('public.%I', relation_name)) is null then
      raise exception 'governed query relation is missing: %', relation_name;
    end if;
    -- SELECT * is expanded and frozen when the view is created, so a column
    -- added later is not queryable until this function runs again.
    select exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = relation_name and column_name = 'org_id'
    ) into has_org_id;
    if has_org_id then
      execute format(
        'create view openbooks_query.%1$I with (security_barrier=true) as '
        'select * from public.%1$I '
        'where org_id = public.openbooks_query_org_id()',
        relation_name
      );
    elsif relation_name = any(global_relations) then
      execute format(
        'create view openbooks_query.%1$I with (security_barrier=true) as select * from public.%1$I',
        relation_name
      );
    else
      raise exception
        'governed query relation % has no org_id and is not an explicitly reviewed global relation',
        relation_name;
    end if;
    execute format('grant select on openbooks_query.%I to openbooks_read', relation_name);
  end loop;

  -- Party dimensions are reportable, but full tax identifiers, sealed bank
  -- details and arbitrary source-system custom payloads are not.
  create view openbooks_query.parties with (security_barrier=true) as
    select id, org_id, kind, display_name, legal_name, short_code, email, phone,
           website, subsidiary_id, is_active, invoicing_preference,
           invoicing_profile, created_at, created_by, updated_at, updated_by
      from public.parties
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.customer_roles with (security_barrier=true) as
    select id, org_id, party_id, ar_account_id, payment_terms_id, credit_limit,
           currency, sales_rep_id, tax_code_id, is_on_hold, hold_reason, held_at,
           held_by, is_active, created_at, created_by, updated_at, updated_by
      from public.customer_roles
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.vendor_roles with (security_barrier=true) as
    select id, org_id, party_id, ap_account_id, payment_terms_id,
           default_expense_account_id, payment_method, eft_notification_email,
           currency, tax_code_id, is_t4a, compliance_class_id,
           information_return_form, information_return_box, tax_classification,
           tin_last4, tin_type, backup_withholding, is_on_hold, hold_reason,
           held_at, held_by, is_active, created_at, created_by, updated_at, updated_by
      from public.vendor_roles
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.party_bank_accounts with (security_barrier=true) as
    select id, org_id, party_id, bank_name, country, currency, account_last_four,
           approved_at, approved_by, approval_status, submitted_by, submitted_at,
           retired_at, retired_by, retirement_reason, is_active,
           created_at, created_by, updated_at, updated_by
      from public.party_bank_accounts
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.subsidiaries with (security_barrier=true) as
    select id, org_id, parent_id, name, legal_name, base_currency, country,
           is_elimination, is_active, created_at, created_by, updated_at, updated_by
      from public.subsidiaries
     where org_id = public.openbooks_query_org_id();
  -- Payroll profiles are reportable, but the sealed national identifier is not:
  -- sin_encrypted is envelope-encrypted SIN/SSN ciphertext and never leaves the
  -- payroll engine. sin_last3 is the identify-without-reveal substitute.
  create view openbooks_query.employee_payroll_profiles with (security_barrier=true) as
    select id, org_id, employee_party_id, pay_schedule_id, province,
           pay_basis, federal_claim_code, federal_claim_amount,
           provincial_claim_code, provincial_claim_amount,
           additional_tax_per_period, prescribed_zone_deduction,
           authorized_annual_deductions, authorized_federal_credits,
           authorized_provincial_credits, cpp_exempt, ei_exempt,
           tax_exempt, vacation_percent, vacation_method, is_active,
           created_at, created_by, updated_at, updated_by,
           union_agreement_id, union_classification_id, country,
           filing_status, multiple_jobs, dependent_credits,
           other_income_annual, deductions_annual, w4_pre_2020,
           w4_allowances, fica_exempt, futa_exempt, sin_last3,
           filing_account_id, stub_delivery, payment_method,
           labour_jurisdiction
      from public.employee_payroll_profiles
     where org_id = public.openbooks_query_org_id();
  -- Employment records are reportable; date of birth is not. It exists for ROE
  -- demographics and the stub-password policy, and the schema comment on
  -- employee_roles.birth_date already states it stays out of these views.
  create view openbooks_query.employee_roles with (security_barrier=true) as
    select id, org_id, party_id, employee_number, department_id,
           supervisor_id, trade_id, worker_comp_group_id, hired_on,
           terminated_on, has_benefits, vacation_days_per_year,
           billable_utilization_target, expense_account_id,
           external_payroll_id, is_active, custom, created_at, created_by,
           updated_at, updated_by, job_title
      from public.employee_roles
     where org_id = public.openbooks_query_org_id();
  -- CRM activity rows remain reportable, but private notes never cross the
  -- governed-query boundary. The flag is retained so reports can count or
  -- filter private rows without seeing their body.
  create view openbooks_query.crm_activities with (security_barrier=true) as
    select id, org_id, kind, status, subject,
           case when is_private then null else body end as body,
           priority, owner_user_id, assigned_user_id, starts_at, ends_at,
           due_at, completed_at, reminder_at, duration_minutes, recurrence,
           is_private, custom, created_at, created_by, updated_at, updated_by
      from public.crm_activities
     where org_id = public.openbooks_query_org_id();
  -- Time rows remain available for hours, rates, billing, and payroll
  -- reporting, but private memo text is redacted in the governed catalog.
  create view openbooks_query.time_entries with (security_barrier=true) as
    select id, org_id, employee_party_id, worked_on, hours, time_type_id,
           item_id, project_id, project_task_id, department_id,
           case when memo_is_private then null else memo end as memo,
           memo_is_private, is_billable, cost_rate, bill_rate, status,
           approved_by, approved_at, cost_journal_entry_id, invoiced_by_line_id,
           payroll_batch_ref, created_at, created_by, updated_at, updated_by,
           custom, overhead_journal_entry_id, field_ticket_id,
           labor_cost_rate_id, wage_rate, wage_currency, wage_fx_rate,
           cost_rate_currency, cost_rate_subsidiary_id, bill_rate_source_rate,
           bill_rate_source_currency, bill_rate_fx_rate, bill_rate_currency,
           bill_rate_book_id, bill_rate_version_id, bill_rate_line_id,
           billing_status, costing_basis, started_at, rejection_reason,
           amends_entry_id
      from public.time_entries
     where org_id = public.openbooks_query_org_id();
  -- Membership rows inherit tenancy through their owning tax group. They
  -- deliberately cannot use the generic catalog path because the base table
  -- has no org_id of its own.
  create view openbooks_query.tax_group_members with (security_barrier=true) as
    select member.id, member.tax_group_id, member.tax_code_id, member.sequence
      from public.tax_group_members member
      join public.tax_groups tax_group on tax_group.id = member.tax_group_id
     where tax_group.org_id = public.openbooks_query_org_id();

  foreach relation_name in array array[
    'parties', 'customer_roles', 'vendor_roles', 'party_bank_accounts',
    'subsidiaries', 'employee_payroll_profiles', 'employee_roles',
    'crm_activities', 'time_entries', 'tax_group_members'
  ] loop
    execute format('grant select on openbooks_query.%I to openbooks_read', relation_name);
  end loop;
end;
$_$;

-- ---------------------------------------------------------------------------
-- Kernel views, created now so no later full refresh is required.
-- The three replaced tables lost their governed views in 0160; the four new
-- tables never had any. SELECT * is safe here because both tables and views
-- are created by these two migrations in one order on every installation.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS openbooks_query.allocation_rules;
CREATE VIEW openbooks_query.allocation_rules WITH (security_barrier='true') AS
 SELECT * FROM public.allocation_rules
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.allocation_rules TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.allocation_rule_targets;
CREATE VIEW openbooks_query.allocation_rule_targets WITH (security_barrier='true') AS
 SELECT * FROM public.allocation_rule_targets
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.allocation_rule_targets TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.allocation_runs;
CREATE VIEW openbooks_query.allocation_runs WITH (security_barrier='true') AS
 SELECT * FROM public.allocation_runs
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.allocation_runs TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.allocation_rule_versions;
CREATE VIEW openbooks_query.allocation_rule_versions WITH (security_barrier='true') AS
 SELECT * FROM public.allocation_rule_versions
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.allocation_rule_versions TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.allocation_drivers;
CREATE VIEW openbooks_query.allocation_drivers WITH (security_barrier='true') AS
 SELECT * FROM public.allocation_drivers
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.allocation_drivers TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.allocation_driver_values;
CREATE VIEW openbooks_query.allocation_driver_values WITH (security_barrier='true') AS
 SELECT * FROM public.allocation_driver_values
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.allocation_driver_values TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.allocation_lineage;
CREATE VIEW openbooks_query.allocation_lineage WITH (security_barrier='true') AS
 SELECT * FROM public.allocation_lineage
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.allocation_lineage TO openbooks_read;

-- ---------------------------------------------------------------------------
-- Stamped views, rebuilt with explicit column lists.
-- 0160 added contributor_kind/ref to journal_lines and distribution_* to
-- document_lines after these governed views were frozen by an older refresh.
-- The explicit lists pin one column order on every installation (a later
-- ALTER on one installation would otherwise leave prod and fresh bootstraps
-- disagreeing); the new stamps ride at the end, after every legacy column.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS openbooks_query.journal_lines;
CREATE VIEW openbooks_query.journal_lines WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    entry_id,
    line_number,
    account_id,
    amount,
    currency,
    txn_amount,
    fx_rate,
    memo,
    party_id,
    department_id,
    project_id,
    location_id,
    class_id,
    payment_card_id,
    extra_dims,
    posting_date,
    quantity,
    unit,
    due_date,
    is_open_item,
    tax_code_id,
    reconciled_at,
    reconciliation_id,
    custom,
    subsidiary_id,
    equipment_unit_id,
    source_cleared_date,
    source_cleared_connector,
    contributor_kind,
    contributor_ref
   FROM public.journal_lines
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.journal_lines TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.document_lines;
CREATE VIEW openbooks_query.document_lines WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    document_id,
    line_number,
    item_id,
    account_id,
    description,
    quantity,
    unit,
    unit_price,
    amount,
    tax_code_id,
    tax_amount,
    department_id,
    project_id,
    location_id,
    class_id,
    employee_id,
    time_entry_id,
    time_type_id,
    cost_multiplier,
    is_billable,
    billed_by_line_id,
    quantity_fulfilled,
    quantity_billed,
    custom,
    created_at,
    created_by,
    updated_at,
    updated_by,
    tax_overridden,
    subsidiary_id,
    extra_dims,
    stock_location_id,
    party_id,
    equipment_unit_id,
    rate_version_id,
    rate_presentation,
    base_quantity,
    base_unit,
    cost_rate,
    bill_rate,
    cost_amount,
    bill_amount,
    recovery_account_id,
    tax_group_id,
    tax_input_amount,
    field_ticket_id,
    markup_percent,
    distribution_group_id,
    distribution_rule_id,
    distribution_version_id,
    distribution_locked
   FROM public.document_lines
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.document_lines TO openbooks_read;
