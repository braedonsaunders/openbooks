-- openbooks referential integrity.
-- Applied after the generated DDL. FKs live here (rather than inline in
-- Drizzle) to keep the schema files free of circular imports; this file is
-- the single authoritative FK map.

-- kernel
alter table journal_entries
  add foreign key (period_id) references accounting_periods(id),
  add foreign key (book_id) references accounting_books(id),
  add foreign key (reverses_entry_id) references journal_entries(id),
  add foreign key (source_document_id) references documents(id);
alter table journal_lines
  add foreign key (entry_id) references journal_entries(id),
  add foreign key (account_id) references accounts(id),
  add foreign key (party_id) references parties(id),
  add foreign key (department_id) references departments(id),
  add foreign key (project_id) references projects(id),
  add foreign key (location_id) references locations(id),
  add foreign key (class_id) references classes(id),
  add foreign key (payment_card_id) references payment_cards(id),
  add foreign key (tax_code_id) references tax_codes(id);
alter table applications
  add foreign key (from_line_id) references journal_lines(id),
  add foreign key (to_line_id) references journal_lines(id),
  add foreign key (fx_gain_loss_entry_id) references journal_entries(id);

-- org structure (orgs.parent_id was dropped in 0028 — subsidiaries carry the
-- consolidation hierarchy now)
alter table accounting_periods
  add foreign key (org_id) references orgs(id);
alter table accounting_books add foreign key (org_id) references orgs(id);
-- Fiscal-calendar, period-lock, and close-system FKs are created by
-- generated/0030_close_operating_system.sql so incremental upgrades receive
-- the same integrity as fresh databases without duplicating constraints here.
alter table accounts
  add foreign key (org_id) references orgs(id),
  add foreign key (parent_id) references accounts(id);
alter table departments add foreign key (parent_id) references departments(id);
alter table locations add foreign key (parent_id) references locations(id);
alter table classes add foreign key (parent_id) references classes(id);
alter table projects
  add foreign key (parent_id) references projects(id),
  add foreign key (customer_id) references parties(id),
  add foreign key (foreman_id) references parties(id),
  add foreign key (manager_id) references parties(id);
-- intercompany_pairs FKs live in generated/0028_subsidiaries.sql (the table
-- was rebuilt there from org refs to subsidiary refs, with its FK set).
alter table fx_provider_configs
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (base_currency) references currencies(code) on delete restrict,
  add foreign key (created_by) references users(id) on delete set null,
  add foreign key (updated_by) references users(id) on delete set null;
alter table fx_provider_runs
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (provider_config_id) references fx_provider_configs(id) on delete cascade,
  add foreign key (created_by) references users(id) on delete set null;
alter table fx_rates add foreign key (provider_config_id) references fx_provider_configs(id) on delete set null;
alter table payment_cards
  add foreign key (holder_party_id) references parties(id),
  add foreign key (liability_account_id) references accounts(id);

-- parties
alter table customer_roles
  add foreign key (party_id) references parties(id),
  add foreign key (ar_account_id) references accounts(id),
  add foreign key (payment_terms_id) references payment_terms(id),
  add foreign key (sales_rep_id) references parties(id),
  add foreign key (tax_code_id) references tax_codes(id);
alter table vendor_roles
  add foreign key (party_id) references parties(id),
  add foreign key (ap_account_id) references accounts(id),
  add foreign key (payment_terms_id) references payment_terms(id),
  add foreign key (default_expense_account_id) references accounts(id),
  add foreign key (tax_code_id) references tax_codes(id);
alter table employee_roles
  add foreign key (party_id) references parties(id),
  add foreign key (department_id) references departments(id),
  add foreign key (supervisor_id) references parties(id),
  add foreign key (trade_id) references trades(id),
  add foreign key (worker_comp_group_id) references worker_comp_groups(id),
  add foreign key (expense_account_id) references accounts(id);
alter table addresses add foreign key (party_id) references parties(id);
alter table contacts
  add foreign key (org_id) references orgs(id),
  add foreign key (party_id) references parties(id) on delete cascade,
  add foreign key (created_by) references users(id),
  add foreign key (updated_by) references users(id);
alter table party_bank_accounts add foreign key (party_id) references parties(id);

-- tax
alter table tax_rates add foreign key (tax_code_id) references tax_codes(id);
alter table tax_codes
  add foreign key (collected_account_id) references accounts(id),
  add foreign key (paid_account_id) references accounts(id);
alter table tax_group_members
  add foreign key (tax_group_id) references tax_groups(id),
  add foreign key (tax_code_id) references tax_codes(id);
alter table tax_report_lines add foreign key (tax_code_id) references tax_codes(id);

-- documents
alter table documents
  add foreign key (party_id) references parties(id),
  add foreign key (posted_entry_id) references journal_entries(id),
  add foreign key (department_id) references departments(id),
  add foreign key (project_id) references projects(id),
  add foreign key (location_id) references locations(id),
  add foreign key (class_id) references classes(id),
  add foreign key (payment_card_id) references payment_cards(id);
alter table document_lines
  add foreign key (document_id) references documents(id),
  add foreign key (item_id) references items(id),
  add foreign key (account_id) references accounts(id),
  add foreign key (tax_code_id) references tax_codes(id),
  add foreign key (employee_id) references parties(id),
  add foreign key (time_entry_id) references time_entries(id),
  add foreign key (time_type_id) references time_types(id),
  add foreign key (billed_by_line_id) references document_lines(id);
alter table document_links
  add foreign key (from_document_id) references documents(id),
  add foreign key (to_document_id) references documents(id);
alter table items
  add foreign key (income_account_id) references accounts(id),
  add foreign key (expense_account_id) references accounts(id),
  add foreign key (tax_code_id) references tax_codes(id);
alter table labor_burden_rates add foreign key (department_id) references departments(id);

-- approvals
alter table approval_requests add foreign key (policy_id) references approval_policies(id);
alter table approval_steps
  add foreign key (request_id) references approval_requests(id),
  add foreign key (assignee_party_id) references parties(id);

-- inventory
alter table stock_locations
  add foreign key (location_id) references locations(id),
  add foreign key (parent_id) references stock_locations(id);
alter table item_inventory_profiles
  add foreign key (item_id) references items(id),
  add foreign key (asset_account_id) references accounts(id),
  add foreign key (cogs_account_id) references accounts(id),
  add foreign key (adjustment_account_id) references accounts(id),
  add foreign key (variance_account_id) references accounts(id);
alter table lots add foreign key (item_id) references items(id);
alter table serials
  add foreign key (item_id) references items(id),
  add foreign key (current_stock_location_id) references stock_locations(id);
alter table inventory_movements
  add foreign key (item_id) references items(id),
  add foreign key (stock_location_id) references stock_locations(id),
  add foreign key (lot_id) references lots(id),
  add foreign key (serial_id) references serials(id),
  add foreign key (document_line_id) references document_lines(id),
  add foreign key (journal_entry_id) references journal_entries(id),
  add foreign key (paired_movement_id) references inventory_movements(id);
alter table cost_layers
  add foreign key (item_id) references items(id),
  add foreign key (stock_location_id) references stock_locations(id),
  add foreign key (source_movement_id) references inventory_movements(id);
alter table cost_layer_consumptions
  add foreign key (cost_layer_id) references cost_layers(id),
  add foreign key (issue_movement_id) references inventory_movements(id);
alter table stock_counts
  add foreign key (location_id) references locations(id),
  add foreign key (posted_entry_id) references journal_entries(id);
alter table stock_count_lines
  add foreign key (stock_count_id) references stock_counts(id),
  add foreign key (item_id) references items(id),
  add foreign key (stock_location_id) references stock_locations(id),
  add foreign key (adjustment_movement_id) references inventory_movements(id);
alter table landed_cost_allocations
  add foreign key (source_document_line_id) references document_lines(id),
  add foreign key (target_cost_layer_id) references cost_layers(id),
  add foreign key (journal_entry_id) references journal_entries(id);
alter table bom_components
  add foreign key (assembly_item_id) references items(id),
  add foreign key (component_item_id) references items(id);

-- revenue recognition
alter table revenue_contracts add foreign key (customer_id) references parties(id);
alter table recognition_rules
  add foreign key (deferred_account_id) references accounts(id),
  add foreign key (recognized_account_id) references accounts(id);
alter table performance_obligations
  add foreign key (contract_id) references revenue_contracts(id),
  add foreign key (document_line_id) references document_lines(id),
  add foreign key (item_id) references items(id),
  add foreign key (recognition_rule_id) references recognition_rules(id);
alter table recognition_schedules
  add foreign key (obligation_id) references performance_obligations(id),
  add foreign key (book_id) references accounting_books(id);
alter table recognition_schedule_lines
  add foreign key (schedule_id) references recognition_schedules(id),
  add foreign key (period_id) references accounting_periods(id),
  add foreign key (journal_entry_id) references journal_entries(id);

-- fixed assets
alter table fixed_assets
  add foreign key (category_id) references asset_categories(id),
  add foreign key (source_document_line_id) references document_lines(id),
  add foreign key (department_id) references departments(id),
  add foreign key (project_id) references projects(id),
  add foreign key (location_id) references locations(id),
  add foreign key (custodian_party_id) references parties(id);
alter table asset_categories
  add foreign key (asset_account_id) references accounts(id),
  add foreign key (accumulated_depreciation_account_id) references accounts(id),
  add foreign key (depreciation_expense_account_id) references accounts(id),
  add foreign key (gain_loss_account_id) references accounts(id);
alter table depreciation_schedules
  add foreign key (asset_id) references fixed_assets(id),
  add foreign key (book_id) references accounting_books(id);
alter table depreciation_schedule_lines
  add foreign key (schedule_id) references depreciation_schedules(id),
  add foreign key (period_id) references accounting_periods(id),
  add foreign key (journal_entry_id) references journal_entries(id);
alter table asset_events
  add foreign key (asset_id) references fixed_assets(id),
  add foreign key (journal_entry_id) references journal_entries(id);

-- banking
alter table bank_statements add foreign key (account_id) references accounts(id);
alter table bank_statement_lines add foreign key (statement_id) references bank_statements(id);
alter table reconciliations add foreign key (account_id) references accounts(id);
alter table reconciliation_matches
  add foreign key (reconciliation_id) references reconciliations(id),
  add foreign key (statement_line_id) references bank_statement_lines(id),
  add foreign key (journal_line_id) references journal_lines(id);
alter table payment_runs add foreign key (bank_account_id) references accounts(id);
alter table payment_instructions
  add foreign key (payment_run_id) references payment_runs(id),
  add foreign key (payee_party_id) references parties(id),
  add foreign key (payee_bank_account_id) references party_bank_accounts(id),
  add foreign key (payment_document_id) references documents(id),
  add foreign key (mandate_id) references payment_mandates(id);
alter table payment_runs
  add foreign key (payment_bank_profile_id) references payment_bank_profiles(id),
  add foreign key (subsidiary_id) references subsidiaries(id),
  add foreign key (source_schedule_id) references payment_schedules(id),
  add foreign key (parent_payment_run_id) references payment_runs(id);
alter table payment_formats add foreign key (org_id) references orgs(id) on delete cascade;
alter table payment_bank_profiles
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (bank_account_id) references accounts(id),
  add foreign key (subsidiary_id) references subsidiaries(id),
  add foreign key (payment_format_id) references payment_formats(id),
  add foreign key (sftp_server_id) references sftp_servers(id);
alter table payment_schedules
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (payment_bank_profile_id) references payment_bank_profiles(id),
  add foreign key (last_payment_run_id) references payment_runs(id);
alter table payment_run_items
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (payment_run_id) references payment_runs(id),
  add foreign key (payment_instruction_id) references payment_instructions(id),
  add foreign key (source_document_id) references documents(id),
  add foreign key (source_open_line_id) references journal_lines(id);
alter table payment_files
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (payment_run_id) references payment_runs(id),
  add foreign key (payment_bank_profile_id) references payment_bank_profiles(id),
  add foreign key (payment_format_id) references payment_formats(id),
  add foreign key (parent_payment_file_id) references payment_files(id),
  add foreign key (file_id) references files(id),
  add foreign key (file_version_id) references file_versions(id);
alter table payment_file_deliveries
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (payment_file_id) references payment_files(id);
alter table payment_mandates
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (party_id) references parties(id),
  add foreign key (party_bank_account_id) references party_bank_accounts(id),
  add foreign key (proof_file_id) references files(id);
alter table payment_settlements
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (payment_instruction_id) references payment_instructions(id),
  add foreign key (bank_statement_line_id) references bank_statement_lines(id),
  add foreign key (reversal_document_id) references documents(id),
  add foreign key (reversal_entry_id) references journal_entries(id);
alter table payment_remittances
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (payment_instruction_id) references payment_instructions(id),
  add foreign key (file_id) references files(id);
alter table payment_events
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (payment_run_id) references payment_runs(id),
  add foreign key (payment_instruction_id) references payment_instructions(id),
  add foreign key (payment_file_id) references payment_files(id),
  add foreign key (actor_id) references users(id);

-- planning
alter table budget_scenarios add foreign key (book_id) references accounting_books(id);
alter table budget_lines
  add foreign key (scenario_id) references budget_scenarios(id),
  add foreign key (account_id) references accounts(id),
  add foreign key (period_id) references accounting_periods(id);
alter table allocation_rules add foreign key (offset_account_id) references accounts(id);
alter table allocation_rule_targets
  add foreign key (rule_id) references allocation_rules(id),
  add foreign key (target_account_id) references accounts(id);
alter table allocation_runs
  add foreign key (rule_id) references allocation_rules(id),
  add foreign key (period_id) references accounting_periods(id),
  add foreign key (journal_entry_id) references journal_entries(id);

-- time
alter table time_entries
  add foreign key (employee_party_id) references parties(id),
  add foreign key (time_type_id) references time_types(id),
  add foreign key (item_id) references items(id),
  add foreign key (project_id) references projects(id),
  add foreign key (project_task_id) references project_tasks(id),
  add foreign key (department_id) references departments(id),
  add foreign key (cost_journal_entry_id) references journal_entries(id),
  add foreign key (invoiced_by_line_id) references document_lines(id);
alter table project_tasks
  add foreign key (project_id) references projects(id),
  add foreign key (parent_id) references project_tasks(id);
alter table recurring_schedules
  add foreign key (template_document_id) references documents(id);

-- inventory movements share the ledger's immutability discipline
create or replace function inv_move_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception 'inventory movement % is posted and cannot be deleted', old.id;
    end if;
    return old;
  end if;
  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'inventory movement % is posted and immutable', old.id;
  end if;
  return new;
end $$;

create trigger inv_move_guard before update or delete on inventory_movements
  for each row execute function inv_move_guard();

-- scripting
alter table script_runs add foreign key (script_id) references user_scripts(id);

-- custom records
alter table custom_record_types add foreign key (org_id) references orgs(id);
alter table custom_records add foreign key (org_id) references orgs(id);
alter table custom_records add foreign key (type_id) references custom_record_types(id) on delete restrict;

-- reporting
alter table report_definitions add foreign key (org_id) references orgs(id);
alter table report_schedules add foreign key (org_id) references orgs(id), add foreign key (definition_id) references report_definitions(id) on delete cascade;
alter table report_runs add foreign key (org_id) references orgs(id), add foreign key (schedule_id) references report_schedules(id) on delete set null, add foreign key (definition_id) references report_definitions(id) on delete cascade;

-- insights
alter table insight_cards add foreign key (org_id) references orgs(id);
alter table insight_dashboards add foreign key (org_id) references orgs(id);
alter table insight_dashboard_pins add foreign key (org_id) references orgs(id), add foreign key (user_id) references users(id) on delete cascade, add foreign key (dashboard_id) references insight_dashboards(id) on delete cascade;

-- views (NetSuite Saved Search analogue — Knowledge menu)
alter table saved_views add foreign key (org_id) references orgs(id);
alter table saved_views add foreign key (owner_id) references users(id) on delete cascade;
alter table saved_views add foreign key (created_by) references users(id);
alter table saved_views add foreign key (updated_by) references users(id);

-- file cabinet (replaced the legacy attachments tables — dropped in 0012_file-cabinet)
alter table folders add foreign key (org_id) references orgs(id);
alter table folders add foreign key (parent_folder_id) references folders(id) on delete restrict;
alter table files add foreign key (org_id) references orgs(id);
alter table files add foreign key (folder_id) references folders(id) on delete restrict;
alter table files add foreign key (current_version_id) references file_versions(id) on delete set null;
alter table file_versions add foreign key (file_id) references files(id) on delete cascade;
alter table file_blobs add foreign key (version_id) references file_versions(id) on delete cascade;
alter table file_attachments add foreign key (org_id) references orgs(id);
alter table file_attachments add foreign key (file_id) references files(id) on delete cascade;

-- ai assistant
alter table ai_conversations add foreign key (org_id) references orgs(id), add foreign key (user_id) references users(id) on delete cascade;
alter table ai_messages add foreign key (org_id) references orgs(id), add foreign key (conversation_id) references ai_conversations(id) on delete cascade;

-- dashboard layouts
alter table user_dashboard_layouts add foreign key (org_id) references orgs(id), add foreign key (user_id) references users(id) on delete cascade;
alter table role_dashboard_layouts add foreign key (org_id) references orgs(id);

-- api keys
alter table api_keys add foreign key (org_id) references orgs(id) on delete cascade;
alter table api_keys add foreign key (user_id) references users(id) on delete cascade;
alter table api_keys add foreign key (created_by) references users(id);
alter table api_keys add foreign key (updated_by) references users(id);
alter table api_key_events add foreign key (org_id) references orgs(id) on delete cascade;
alter table api_key_events add foreign key (key_id) references api_keys(id) on delete set null;

-- customization (transaction form layouts + saved list views)
alter table form_layouts add foreign key (org_id) references orgs(id);
alter table user_form_preferences add foreign key (org_id) references orgs(id), add foreign key (user_id) references users(id) on delete cascade, add foreign key (layout_id) references form_layouts(id) on delete set null;
alter table list_views add foreign key (org_id) references orgs(id), add foreign key (owner_id) references users(id) on delete cascade;
alter table user_list_preferences add foreign key (org_id) references orgs(id), add foreign key (user_id) references users(id) on delete cascade, add foreign key (view_id) references list_views(id) on delete set null;

-- pdf templates (org-authored printable documents)
alter table pdf_templates add foreign key (org_id) references orgs(id);
alter table pdf_templates add foreign key (created_by) references users(id);
alter table pdf_templates add foreign key (updated_by) references users(id);

-- environments (sandboxes). The sandbox org row itself carries sandbox_of →
-- production; deleting a sandbox org cascades its business rows via each
-- table's org_id FK. Note sandbox_of is intentionally NOT cascade-on-delete of
-- the production org — a production org can't be deleted while sandboxes exist.
alter table orgs add foreign key (sandbox_of) references orgs(id);
alter table sandboxes
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (production_org_id) references orgs(id),
  add foreign key (as_of_period_id) references accounting_periods(id);
alter table masking_policies add foreign key (org_id) references orgs(id) on delete cascade;
alter table change_sets
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (sandbox_org_id) references orgs(id) on delete cascade;
alter table change_set_items
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (change_set_id) references change_sets(id) on delete cascade;

-- multi-org identity (one login across tenants)
alter table user_org_access
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (member_user_id) references users(id) on delete cascade,
  add foreign key (acting_user_id) references users(id) on delete cascade;

-- flows (graph automation + approval gates + in-app inbox).
-- Deleting a flow cascades its run history; runs cascade their checkpoints
-- and gates. Assignee/decider FKs are plain (deleting a user must not erase
-- decision history); a user's inbox rows go with the user.
alter table flows add foreign key (org_id) references orgs(id) on delete cascade;
alter table flow_runs
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (flow_id) references flows(id) on delete cascade;
alter table flow_run_effects
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (run_id) references flow_runs(id) on delete cascade;
alter table flow_gates
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (flow_id) references flows(id) on delete cascade,
  add foreign key (run_id) references flow_runs(id) on delete cascade,
  add foreign key (assignee_user_id) references users(id),
  add foreign key (decided_by) references users(id);
alter table approval_delegations
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (from_user_id) references users(id),
  add foreign key (to_user_id) references users(id);
alter table flow_locks
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (flow_id) references flows(id) on delete cascade;

-- accounting segment registry and custom values
alter table segment_definitions
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (created_by) references users(id),
  add foreign key (updated_by) references users(id);
alter table segment_values
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (segment_id) references segment_definitions(id) on delete restrict,
  add foreign key (parent_id) references segment_values(id) on delete restrict,
  add foreign key (subsidiary_id) references subsidiaries(id) on delete restrict,
  add foreign key (created_by) references users(id),
  add foreign key (updated_by) references users(id);
alter table notifications
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (user_id) references users(id) on delete cascade;

-- apps (installable packages: bundle + sandboxed backend + KV).
-- Deleting an app cascades its versions, files, storage and run log; the app's
-- active_version_id nulls out rather than blocking the version delete.
alter table apps
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (active_version_id) references app_versions(id) on delete set null;
alter table app_versions
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (app_id) references apps(id) on delete cascade;
alter table app_files
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (app_id) references apps(id) on delete cascade,
  add foreign key (version_id) references app_versions(id) on delete cascade;
alter table app_storage
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (app_id) references apps(id) on delete cascade;
alter table app_runs
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (app_id) references apps(id) on delete cascade;
alter table app_listings
  add foreign key (publisher_org_id) references orgs(id) on delete cascade;
