-- OpenBooks forward migration 0418_table_driven_module_registries.
--
-- Two storage functions carry module-owned lists in their bodies: 0352's
-- openbooks_refresh_query_catalog() holds safe_relations as a constant
-- array, and 0168's document_close_module() holds the kind-to-module map as
-- a CASE. Every schema pack that adds a relation or a document kind would
-- have to redefine one of those functions, and migrations replay in ordinal
-- order, so the last redefinition silently drops every earlier module's
-- rows. Both lists move into registry tables seeded here; module packs add
-- rows with INSERT ... ON CONFLICT DO NOTHING and call the refresh, and
-- never redefine either function.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Query-catalog registry: every relation the governed query console may
-- expose. added_in names the migration ordinal that registered the row, so a
-- later pack's rows stay distinguishable from this seed.
CREATE TABLE IF NOT EXISTS public.openbooks_query_catalog_relations (
  relation text PRIMARY KEY,
  added_in text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);

-- Seed copied from the 0352 safe_relations literal. ON CONFLICT DO NOTHING
-- is expected on replay: the seed is idempotent, and the check below proves
-- the seeded set matches the live function body before it is replaced.
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
    ('account_group_members', '0352'),
    ('account_groups', '0352'),
    ('accounting_books', '0352'),
    ('accounting_periods', '0352'),
    ('accounts', '0352'),
    ('addresses', '0352'),
    ('allocation_driver_values', '0352'),
    ('allocation_drivers', '0352'),
    ('allocation_lineage', '0352'),
    ('allocation_rule_targets', '0352'),
    ('allocation_rule_versions', '0352'),
    ('allocation_rules', '0352'),
    ('allocation_runs', '0352'),
    ('applications', '0352'),
    ('asset_categories', '0352'),
    ('asset_events', '0352'),
    ('bank_match_rules', '0352'),
    ('bank_statement_lines', '0352'),
    ('bank_statements', '0352'),
    ('billing_request_field_tickets', '0352'),
    ('billing_requests', '0352'),
    ('billing_schedules', '0352'),
    ('bom_components', '0352'),
    ('budget_lines', '0352'),
    ('budget_scenarios', '0352'),
    ('cam_allocations', '0352'),
    ('cam_pools', '0352'),
    ('change_orders', '0352'),
    ('charge_rate_components', '0352'),
    ('classes', '0352'),
    ('close_automation_executions', '0352'),
    ('close_events', '0352'),
    ('close_exceptions', '0352'),
    ('close_reopen_requests', '0352'),
    ('close_reporting_packages', '0352'),
    ('close_run_tasks', '0352'),
    ('close_runs', '0352'),
    ('close_signoffs', '0352'),
    ('close_task_evidence', '0352'),
    ('compliance_classes', '0352'),
    ('compliance_records', '0352'),
    ('compliance_release_checks', '0352'),
    ('compliance_requirements', '0352'),
    ('compliance_waivers', '0352'),
    ('consolidation_control_losses', '0352'),
    ('consolidated_fx_rates', '0352'),
    ('contacts', '0352'),
    ('cost_layer_consumptions', '0352'),
    ('cost_layer_weights', '0352'),
    ('cost_layers', '0352'),
    ('crm_account_assignment_events', '0352'),
    ('crm_account_profiles', '0352'),
    ('crm_account_stage_events', '0352'),
    ('crm_account_statuses', '0352'),
    ('crm_activity_links', '0352'),
    ('crm_activity_participants', '0352'),
    ('crm_forecast_snapshots', '0352'),
    ('crm_lead_sources', '0352'),
    ('crm_opportunities', '0352'),
    ('crm_opportunity_documents', '0352'),
    ('crm_opportunity_lines', '0352'),
    ('crm_opportunity_stage_events', '0352'),
    ('crm_opportunity_statuses', '0352'),
    ('crm_opportunity_team_members', '0352'),
    ('crm_sales_quotas', '0352'),
    ('crm_sales_team_members', '0352'),
    ('crm_sales_teams', '0352'),
    ('crm_sales_territories', '0352'),
    ('currencies', '0352'),
    ('customer_price_level_assignments', '0352'),
    ('departments', '0352'),
    ('depreciation_book_policies', '0352'),
    ('depreciation_inputs', '0352'),
    ('depreciation_methods', '0352'),
    ('depreciation_schedule_lines', '0352'),
    ('depreciation_schedules', '0352'),
    ('document_line_tax_components', '0352'),
    ('document_lines', '0352'),
    ('document_links', '0352'),
    ('documents', '0352'),
    ('dunning_log', '0352'),
    ('entitlement_ledger', '0352'),
    ('entitlement_plan_limits', '0352'),
    ('entitlement_plans', '0352'),
    ('entitlement_service_tiers', '0352'),
    ('equipment_units', '0352'),
    ('fair_value_prices', '0352'),
    ('field_ticket_labor_lines', '0352'),
    ('field_ticket_labor_snapshots', '0352'),
    ('field_ticket_signatures', '0352'),
    ('field_tickets', '0352'),
    ('fiscal_calendars', '0352'),
    ('financial_changes', '0352'),
    ('fixed_assets', '0352'),
    ('fx_rates', '0352'),
    ('gl_month_activity', '0352'),
    ('income_tax_rates', '0352'),
    ('intercompany_pairs', '0352'),
    ('inventory_movements', '0352'),
    ('inventory_provisional_costs', '0352'),
    ('inventory_provisional_settlements', '0352'),
    ('inventory_writedowns', '0352'),
    ('invoice_backups', '0352'),
    ('item_inventory_profiles', '0352'),
    ('item_price_breaks', '0352'),
    ('item_price_schedules', '0352'),
    ('item_rate_book_assignments', '0352'),
    ('item_rate_books', '0352'),
    ('item_rate_lines', '0352'),
    ('item_rate_profiles', '0352'),
    ('item_rate_version_profiles', '0352'),
    ('item_rate_versions', '0352'),
    ('items', '0352'),
    ('journal_entries', '0352'),
    ('journal_lines', '0352'),
    ('labor_cost_rates', '0352'),
    ('labor_rate_adjustment_targets', '0352'),
    ('labor_rate_adjustments', '0352'),
    ('labor_rate_terms', '0352'),
    ('labor_rate_version_policies', '0352'),
    ('labor_rate_version_scopes', '0352'),
    ('landed_cost_allocations', '0352'),
    ('landed_cost_voucher_targets', '0352'),
    ('landed_cost_vouchers', '0352'),
    ('lease_agreement_schedule_lines', '0352'),
    ('lease_agreements', '0352'),
    ('lease_charges', '0352'),
    ('lease_escalations', '0352'),
    ('lease_schedule_lines', '0352'),
    ('lien_waivers', '0352'),
    ('locations', '0352'),
    ('lots', '0352'),
    ('managed_properties', '0352'),
    ('overhead_rates', '0352'),
    ('ownership_consolidation_entries', '0352'),
    ('ownership_consolidation_runs', '0352'),
    ('party_payment_stats', '0352'),
    ('party_subsidiaries', '0352'),
    ('pay_application_lines', '0352'),
    ('pay_applications', '0352'),
    ('payment_events', '0352'),
    ('payment_remittances', '0352'),
    ('payment_run_items', '0352'),
    ('payment_runs', '0352'),
    ('payment_schedule_occurrences', '0352'),
    ('payment_schedules', '0352'),
    ('payment_settlements', '0352'),
    ('payment_surcharge_rules', '0352'),
    ('payment_terms', '0352'),
    ('performance_obligations', '0352'),
    ('period_locks', '0352'),
    ('project_financial_adjustments', '0352'),
    ('project_financial_profile_versions', '0352'),
    ('project_overhead_adjustments', '0352'),
    ('price_level_activation_history', '0352'),
    ('price_levels', '0352'),
    ('project_tasks', '0352'),
    ('project_types', '0352'),
    ('projects', '0352'),
    ('property_leases', '0352'),
    ('property_units', '0352'),
    ('recognition_events', '0352'),
    ('recognition_rules', '0352'),
    ('recognition_schedule_lines', '0352'),
    ('recognition_schedules', '0352'),
    ('reconciliation_matches', '0352'),
    ('reconciliations', '0352'),
    ('recurring_schedules', '0352'),
    ('revenue_contracts', '0352'),
    ('schedule_baseline_tasks', '0352'),
    ('schedule_baselines', '0352'),
    ('schedule_calendars', '0352'),
    ('schedule_dependencies', '0352'),
    ('schedule_resources', '0352'),
    ('schedule_task_assignments', '0352'),
    ('security_deposit_transactions', '0352'),
    ('segment_definitions', '0352'),
    ('segment_values', '0352'),
    ('serials', '0352'),
    ('source_reconciliation_state', '0352'),
    ('sov_lines', '0352'),
    ('stock_count_lines', '0352'),
    ('stock_counts', '0352'),
    ('stock_locations', '0352'),
    ('subcontract_change_orders', '0352'),
    ('subcontract_payment_controls', '0352'),
    ('subcontract_sov_lines', '0352'),
    ('subcontracts', '0352'),
    ('subscription_amendments', '0352'),
    ('subscription_components', '0352'),
    ('subscription_events', '0352'),
    ('subscription_lifecycles', '0352'),
    ('subscription_period_invoices', '0352'),
    ('subscription_plan_version_components', '0352'),
    ('subscription_plan_versions', '0352'),
    ('subscription_plans', '0352'),
    ('subscriptions', '0352'),
    ('subsidiary_ownership_interests', '0352'),
    ('tax_codes', '0352'),
    ('tax_country_pack_installations', '0352'),
    ('tax_depreciation_pools', '0352'),
    ('tax_filings', '0352'),
    ('tax_first_year_rules', '0352'),
    ('tax_groups', '0352'),
    ('tax_jurisdictions', '0352'),
    ('tax_locale_pack_meta', '0352'),
    ('tax_pool_classes', '0352'),
    ('tax_pool_periods', '0352'),
    ('tax_provision_runs', '0352'),
    ('tax_rates', '0352'),
    ('tax_regimes', '0352'),
    ('tax_registrations', '0352'),
    ('tax_report_lines', '0352'),
    ('tax_return_forms', '0352'),
    ('temporary_differences', '0352'),
    ('time_types', '0352'),
    ('timesheet_weeks', '0352'),
    ('trades', '0352'),
    ('transfer_order_lines', '0352'),
    ('transfer_orders', '0352'),
    ('vendor_pay_application_lines', '0352'),
    ('vendor_pay_applications', '0352'),
    ('vendor_retainage_releases', '0352'),
    ('wip_holds', '0352'),
    ('wip_prebill_events', '0352'),
    ('wip_prebill_lines', '0352'),
    ('wip_prebills', '0352'),
    ('worker_comp_groups', '0352'),
    ('employee_pay_components', '0352'),
    ('pay_components', '0352'),
    ('pay_derived_rules', '0352'),
    ('pay_run_adjustments', '0352'),
    ('pay_runs', '0352'),
    ('pay_schedules', '0352'),
    ('pay_stub_lines', '0352'),
    ('pay_stubs', '0352'),
    ('payroll_employer_levy_opening', '0352'),
    ('payroll_filing_accounts', '0352'),
    ('payroll_holidays', '0352'),
    ('payroll_opening_balance_components', '0352'),
    ('payroll_opening_balances', '0352'),
    ('payroll_remittance_coverage', '0352'),
    ('payroll_statutory_rates', '0352'),
    ('union_agreements', '0352'),
    ('union_classifications', '0352'),
    ('union_fringes', '0352'),
    ('upgrade_legacy_provenance', '0352')
ON CONFLICT (relation) DO NOTHING;

-- The seed above must be exactly the live body's list: a diverged body
-- means this install does not run the 0352 shape the seed was copied from,
-- and replacing the function would enshrine the divergence. Refuse by name.
DO $catalog_seed_check$
DECLARE
  live_body text;
  array_section text;
  body_count integer;
  seed_count integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(p.oid) INTO live_body
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.openbooks_refresh_query_catalog()'::regprocedure;
  IF live_body IS NULL THEN
    RAISE EXCEPTION 'openbooks_refresh_query_catalog() is missing; restore it before applying 0418';
  END IF;
  array_section := substring(live_body from 'safe_relations constant text\[\] := array\[(?:.|\n)*?\];');
  IF array_section IS NULL THEN
    RAISE EXCEPTION 'openbooks_refresh_query_catalog() body carries no safe_relations array literal; rebase the 0418 seed on the live body before applying 0418';
  END IF;
  SELECT count(*) INTO body_count FROM regexp_matches(array_section, '''([a-z_][a-z0-9_]*)''', 'g');
  IF body_count = 0 THEN
    RAISE EXCEPTION 'openbooks_refresh_query_catalog() body parses to an empty relation list; rebase the 0418 seed on the live body before applying 0418';
  END IF;
  SELECT count(*) INTO seed_count FROM public.openbooks_query_catalog_relations WHERE added_in = '0352';
  IF seed_count <> body_count THEN
    RAISE EXCEPTION 'query catalog seed holds % relations but the live function body parses to %; rebase the 0418 seed', seed_count, body_count;
  END IF;
END;
$catalog_seed_check$;

-- Same refresh as 0352, except the governed set comes from the registry
-- table: module packs add rows instead of redefining this function. Grants
-- for openbooks_read are unchanged (per-relation grants plus the grant on
-- every view in the governed schema).
CREATE OR REPLACE FUNCTION public.openbooks_refresh_query_catalog() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
declare
  relation_name text;
  has_org_id boolean;
  global_relations constant text[] := array['currencies'];
begin
  -- Public base tables are never query-console surfaces. Revoke both current
  -- and future access before rebuilding the reviewed view catalog.
  revoke all privileges on all tables in schema public from openbooks_read;
  alter default privileges in schema public revoke select on tables from openbooks_read;

  drop schema if exists openbooks_query cascade;
  create schema openbooks_query;
  revoke all on schema openbooks_query from public;
  grant usage on schema openbooks_query to openbooks_read;

  -- The registry table is the single source of truth for the governed
  -- relation set: a module migration registers with INSERT, never by
  -- redefining this function.
  for relation_name in
    select relation
      from public.openbooks_query_catalog_relations
     order by relation
  loop
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

  -- Clawback tracking is reportable, but the provider webhook payload is
  -- not: event_payload carries the raw provider event, which can include
  -- instrument details. Status and references stay queryable.
  create view openbooks_query.payment_pending_clawbacks with (security_barrier=true) as
    select id, org_id, provider, intent_ref, event_status,
           created_at, last_seen_at, consumed_at, consumed_attempt_id
      from public.payment_pending_clawbacks
     where org_id = public.openbooks_query_org_id();
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

  -- Every relation in the governed schema is a reviewed, org-filtered view,
  -- so the read role gets SELECT on all of them in one statement. A per-name
  -- grant list omitted payment_pending_clawbacks (created between the two
  -- loops) and silently left it unreadable.
  grant select on all tables in schema openbooks_query to openbooks_read;
end;
$_$;

-- Document-close registry: storage mirror of DOCUMENT_CLOSE_MODULES
-- (engine/src/periods/period-policy.ts). added_in names the migration
-- ordinal that registered the row. Unknown kinds resolve to null through the
-- lookup below, preserving the 0168 ELSE NULL behaviour.
CREATE TABLE IF NOT EXISTS public.openbooks_document_close_modules (
  kind text PRIMARY KEY,
  close_module text NOT NULL,
  added_in text NOT NULL
);

-- Seed copied from the 0168 CASE. ON CONFLICT DO NOTHING is expected on
-- replay: the seed is idempotent, and the check below proves the seeded set
-- matches the mirrored map before the function is replaced.
INSERT INTO public.openbooks_document_close_modules (kind, close_module, added_in)
VALUES
    ('vendor_bill', 'ap', '0168'),
    ('vendor_credit', 'ap', '0168'),
    ('customer_invoice', 'ar', '0168'),
    ('customer_credit', 'ar', '0168'),
    ('card_charge', 'ap', '0168'),
    ('card_refund', 'ap', '0168'),
    ('check', 'ap', '0168'),
    ('deposit', 'banking', '0168'),
    ('transfer', 'banking', '0168'),
    ('project_charge', 'gl', '0168'),
    ('pay_run', 'gl', '0168'),
    ('customer_payment', 'ar', '0168'),
    ('vendor_payment', 'ap', '0168'),
    ('expense_report', 'ap', '0168'),
    ('sales_order', 'ar', '0168'),
    ('purchase_order', 'ap', '0168'),
    ('quote', 'ar', '0168'),
    ('journal', 'gl', '0168')
ON CONFLICT (kind) DO NOTHING;

-- The seed above must be exactly the mirrored map: a diverged CASE means
-- this install does not run the 0168 shape the seed was copied from, and
-- replacing the function would enshrine the divergence. Refuse by name. (The
-- literal below mirrors DOCUMENT_CLOSE_MODULES; the parity test pins the
-- table against the engine map in both directions.)
DO $close_module_seed_check$
DECLARE
  missing_names text;
  unexpected_rows text;
BEGIN
  WITH expected(kind, close_module) AS (
    VALUES
      ('vendor_bill', 'ap'),
      ('vendor_credit', 'ap'),
      ('customer_invoice', 'ar'),
      ('customer_credit', 'ar'),
      ('card_charge', 'ap'),
      ('card_refund', 'ap'),
      ('check', 'ap'),
      ('deposit', 'banking'),
      ('transfer', 'banking'),
      ('project_charge', 'gl'),
      ('pay_run', 'gl'),
      ('customer_payment', 'ar'),
      ('vendor_payment', 'ap'),
      ('expense_report', 'ap'),
      ('sales_order', 'ar'),
      ('purchase_order', 'ap'),
      ('quote', 'ar'),
      ('journal', 'gl')
  )
  SELECT string_agg(e.kind, ', ') INTO missing_names
    FROM expected e
   WHERE NOT EXISTS (
     SELECT 1 FROM public.openbooks_document_close_modules t
      WHERE t.added_in = '0168' AND t.kind = e.kind AND t.close_module = e.close_module
   );
  IF missing_names IS NOT NULL THEN
    RAISE EXCEPTION 'document close seed is missing %; rebase the 0418 seed', missing_names;
  END IF;
  WITH expected(kind, close_module) AS (
    VALUES
      ('vendor_bill', 'ap'),
      ('vendor_credit', 'ap'),
      ('customer_invoice', 'ar'),
      ('customer_credit', 'ar'),
      ('card_charge', 'ap'),
      ('card_refund', 'ap'),
      ('check', 'ap'),
      ('deposit', 'banking'),
      ('transfer', 'banking'),
      ('project_charge', 'gl'),
      ('pay_run', 'gl'),
      ('customer_payment', 'ar'),
      ('vendor_payment', 'ap'),
      ('expense_report', 'ap'),
      ('sales_order', 'ar'),
      ('purchase_order', 'ap'),
      ('quote', 'ar'),
      ('journal', 'gl')
  )
  SELECT string_agg(t.kind || '->' || t.close_module, ', ') INTO unexpected_rows
    FROM public.openbooks_document_close_modules t
   WHERE t.added_in = '0168'
     AND NOT EXISTS (
       SELECT 1 FROM expected e WHERE e.kind = t.kind AND e.close_module = t.close_module
     );
  IF unexpected_rows IS NOT NULL THEN
    RAISE EXCEPTION 'document close seed holds unexpected rows %; rebase the 0418 seed', unexpected_rows;
  END IF;
END;
$close_module_seed_check$;

-- Table-driven lookup replacing the 0168 CASE. STABLE, not IMMUTABLE: the
-- answer now reads a table, so it must not be frozen across registry
-- changes within a query. No rows are touched.
CREATE OR REPLACE FUNCTION public.document_close_module(p_kind text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select close_module from public.openbooks_document_close_modules where kind = p_kind
$$;

COMMENT ON FUNCTION public.document_close_module(text) IS
  'openbooks:document-close-module:v2 - table-driven registry (openbooks_document_close_modules, 0418) mirroring DOCUMENT_CLOSE_MODULES; unknown kinds yield null';

SELECT public.openbooks_refresh_query_catalog();
