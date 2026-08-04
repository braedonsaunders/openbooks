-- The SQL console is deliberately powerful, but it must never inherit blanket
-- SELECT on the application schema.  openbooks_read sees only the governed
-- views below. Every org-owned view carries an explicit tenant predicate and
-- openbooks_read retains no direct base-table privileges.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'openbooks_read') then
    raise exception 'openbooks_read must be created by bootstrap before migrations';
  end if;
end $$;

-- Resolve tenant identity from an application-owned connection-local temp
-- table. The raw SQL role cannot read or mutate that table, and every user
-- statement runs inside a READ ONLY transaction.
create or replace function public.openbooks_query_org_id()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  resolved_org_id uuid;
begin
  execute 'select org_id from pg_temp.openbooks_query_context limit 1'
    into resolved_org_id;
  return resolved_org_id;
exception
  when undefined_table then return null;
end;
$$;
revoke all on function public.openbooks_query_org_id() from public;
grant execute on function public.openbooks_query_org_id() to openbooks_read;

create or replace function public.openbooks_refresh_query_catalog()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  relation_name text;
  has_org_id boolean;
  global_relations constant text[] := array['currencies'];
  safe_relations constant text[] := array[
    'account_group_members', 'account_groups', 'accounting_books',
    'accounting_periods', 'accounts', 'addresses', 'allocation_rule_targets',
    'allocation_rules', 'allocation_runs', 'applications', 'asset_categories',
    'asset_events', 'bank_match_rules', 'bank_statement_lines', 'bank_statements',
    'billing_request_field_tickets', 'billing_requests', 'billing_schedules',
    'bom_components', 'budget_lines', 'budget_scenarios', 'change_orders',
    'charge_rate_components', 'classes', 'close_automation_executions',
    'close_events', 'close_exceptions', 'close_reopen_requests',
    'close_reporting_packages', 'close_run_tasks', 'close_runs', 'close_signoffs',
    'close_task_evidence', 'compliance_classes', 'compliance_records',
    'compliance_release_checks', 'compliance_requirements', 'compliance_waivers',
    'consolidated_fx_rates', 'contacts', 'cost_layer_consumptions',
    'cost_layer_weights', 'cost_layers', 'crm_account_assignment_events',
    'crm_account_profiles', 'crm_account_stage_events', 'crm_account_statuses',
    'crm_activities', 'crm_activity_links', 'crm_activity_participants',
    'crm_forecast_snapshots', 'crm_lead_sources', 'crm_opportunities',
    'crm_opportunity_documents', 'crm_opportunity_lines',
    'crm_opportunity_stage_events', 'crm_opportunity_statuses',
    'crm_opportunity_team_members', 'crm_sales_quotas', 'crm_sales_team_members',
    'crm_sales_teams', 'crm_sales_territories', 'currencies', 'departments',
    'depreciation_book_policies', 'depreciation_inputs', 'depreciation_methods',
    'depreciation_schedule_lines', 'depreciation_schedules',
    'document_line_tax_components', 'document_lines', 'document_links', 'documents',
    'dunning_log', 'employee_roles', 'equipment_units', 'fair_value_prices',
    'field_ticket_labor_lines', 'field_ticket_labor_snapshots',
    'field_ticket_signatures', 'field_tickets', 'fiscal_calendars', 'fixed_assets',
    'fx_rates', 'income_tax_rates', 'intercompany_pairs', 'inventory_movements',
    'inventory_provisional_costs', 'inventory_provisional_settlements',
    'invoice_backups', 'item_inventory_profiles', 'item_rate_book_assignments',
    'item_rate_books', 'item_rate_lines', 'item_rate_profiles', 'item_rate_versions',
    'items', 'journal_entries', 'journal_lines', 'labor_cost_rates',
    'labor_rate_adjustment_targets', 'labor_rate_adjustments', 'labor_rate_terms',
    'labor_rate_version_policies', 'labor_rate_version_scopes',
    'landed_cost_allocations', 'landed_cost_voucher_targets', 'landed_cost_vouchers',
    'lien_waivers', 'locations', 'lots', 'overhead_rates',
    'ownership_consolidation_entries', 'ownership_consolidation_runs',
    'party_subsidiaries', 'pay_application_lines', 'pay_applications',
    'payment_events', 'payment_remittances', 'payment_run_items', 'payment_runs',
    'payment_schedules', 'payment_settlements', 'payment_surcharge_rules',
    'payment_terms', 'performance_obligations', 'period_locks',
    'project_financial_adjustments', 'project_financial_profile_versions',
    'project_overhead_adjustments', 'project_tasks', 'project_types', 'projects',
    'recognition_rules', 'recognition_schedule_lines', 'recognition_schedules',
    'reconciliation_matches', 'reconciliations', 'recurring_schedules',
    'revenue_contracts', 'schedule_baseline_tasks', 'schedule_baselines',
    'schedule_calendars', 'schedule_dependencies', 'schedule_resources',
    'schedule_task_assignments', 'segment_definitions', 'segment_values', 'serials',
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
    'temporary_differences', 'time_entries', 'time_types', 'trades',
    'transfer_order_lines', 'transfer_orders', 'vendor_pay_application_lines',
    'vendor_pay_applications', 'vendor_retainage_releases', 'wip_holds',
    'wip_prebill_events', 'wip_prebill_lines', 'wip_prebills', 'worker_comp_groups'
  ];
begin
  -- Old migrations granted the role broadly. Revoke both current and future
  -- access before rebuilding the allowlisted catalog.
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
    -- SELECT * is expanded and frozen when the view is created. A later secret
    -- column therefore cannot become queryable until this reviewed allowlist is
    -- deliberately refreshed by a migration.
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
    'subsidiaries', 'tax_group_members'
  ] loop
    execute format('grant select on openbooks_query.%I to openbooks_read', relation_name);
  end loop;
end;
$$;

revoke all on function public.openbooks_refresh_query_catalog() from public;
select public.openbooks_refresh_query_catalog();

do $$
begin
  if exists (
    select 1
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p', 'v', 'm')
       and has_table_privilege('openbooks_read', relation.oid, 'select')
  ) then
    raise exception 'openbooks_read retains forbidden direct public-schema access';
  end if;
  if not exists (
    select 1 from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'openbooks_query' and relation.relkind = 'v'
  ) then
    raise exception 'governed query catalog is empty';
  end if;
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'openbooks_query'
       and table_name in (
         'users', 'user_org_access', 'api_keys', 'connections', 'orgs', 'qbd_sessions',
         'sftp_servers', 'bank_feed_connections', 'payment_links',
         'psp_provider_configs', 'tax_rate_provider_configs'
       )
  ) then
    raise exception 'credential or control relation leaked into governed query catalog';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'openbooks_query'
       and column_name in (
         'password_hash', 'key_hash', 'account_number_encrypted',
         'tin_encrypted', 'originator_secrets_encrypted', 'token_digest', 'secrets'
       )
  ) then
    raise exception 'credential column leaked into governed query catalog';
  end if;
  if exists (
    select 1
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.prosecdef
       and has_function_privilege('openbooks_read', procedure.oid, 'execute')
       and procedure.oid <> 'public.openbooks_query_org_id()'::regprocedure
  ) then
    raise exception 'openbooks_read can execute an unreviewed public SECURITY DEFINER function';
  end if;
end $$;
