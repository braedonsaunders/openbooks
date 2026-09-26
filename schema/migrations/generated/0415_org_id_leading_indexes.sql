-- OpenBooks forward migration 0415_org_id_leading_indexes.
--
-- Every row-level-security predicate in this database compares org_id to the
-- current tenant setting, so every org-scoped table needs an index whose
-- leading column is org_id: without one, each tenant read scans the whole
-- table. Seventy-nine tables carrying org_id had no such index — only
-- narrower indexes on other columns (addresses, for example, had only
-- addresses_party on party_id). Tables that already carry a composite index
-- starting with org_id are left untouched.
--
-- All 79 builds use CREATE INDEX CONCURRENTLY, which PostgreSQL refuses
-- inside a transaction block: this file declares `-- openbooks:
-- no-transaction` and the runner executes it statement by statement with a
-- bounded session lock_timeout. The contract that makes a mid-file failure
-- retry-safe: every statement is idempotent (IF NOT EXISTS throughout), and
-- the DO block up front drops this file's own INVALID indexes — a failed
-- CONCURRENTLY build leaves one behind, and IF NOT EXISTS would otherwise
-- skip the name forever, silently keeping the missing index.
--
-- This file carries no lock_timeout of its own (refused for ordinals above
-- 0251 by check-migration-headers); the runner's bound governs. On a fresh
-- install all of this replays over empty tables in milliseconds.

-- openbooks: no-transaction

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Retry safety: drop this file's own INVALID indexes before rebuilding. A failed
-- CONCURRENTLY build leaves the name present but unusable, and IF NOT EXISTS
-- below would then skip it forever.
DO $$
DECLARE
  idx text;
BEGIN
  FOR idx IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid
       AND c.relname IN (
         'addresses_org_id_idx', 'ai_messages_org_id_idx', 'ai_rails_settings_org_id_idx', 'ai_work_item_evidence_org_id_idx',
         'ap_capture_corrections_org_id_idx', 'ap_capture_events_org_id_idx', 'ap_capture_fields_org_id_idx', 'app_files_org_id_idx',
         'app_runs_org_id_idx', 'asset_transfer_consolidation_entries_org_id_idx', 'bank_match_rules_org_id_idx', 'bom_components_org_id_idx',
         'change_set_items_org_id_idx', 'charge_rate_components_org_id_idx', 'close_blueprint_dependencies_org_id_idx', 'close_blueprint_steps_org_id_idx',
         'close_events_org_id_idx', 'close_exceptions_org_id_idx', 'close_signoffs_org_id_idx', 'close_task_evidence_org_id_idx',
         'cost_layer_consumptions_org_id_idx', 'cost_layer_weights_org_id_idx', 'crew_time_batch_events_org_id_idx', 'crm_account_assignment_events_org_id_idx',
         'crm_account_stage_events_org_id_idx', 'crm_activity_participants_org_id_idx', 'crm_opportunity_documents_org_id_idx', 'crm_opportunity_lines_org_id_idx',
         'crm_opportunity_stage_events_org_id_idx', 'crm_opportunity_team_members_org_id_idx', 'crm_sales_team_members_org_id_idx', 'customer_roles_org_id_idx',
         'dunning_stages_org_id_idx', 'employee_roles_org_id_idx', 'fair_value_prices_org_id_idx', 'flow_run_effects_org_id_idx',
         'flow_scheduled_occurrences_org_id_idx', 'hrm_calibration_sessions_org_id_idx', 'hrm_comp_cycle_budgets_org_id_idx', 'hrm_comp_events_org_id_idx',
         'hrm_comp_statements_org_id_idx', 'hrm_competency_frameworks_org_id_idx', 'hrm_pay_information_requests_org_id_idx', 'hrm_qualification_settings_org_id_idx',
         'intercompany_pairs_org_id_idx', 'inventory_provisional_settlements_org_id_idx', 'item_inventory_profiles_org_id_idx', 'labor_rate_adjustment_targets_org_id_idx',
         'labor_rate_terms_org_id_idx', 'labor_rate_version_policies_org_id_idx', 'labor_rate_version_scopes_org_id_idx', 'landed_cost_allocations_org_id_idx',
         'landed_cost_voucher_targets_org_id_idx', 'lots_org_id_idx', 'overhead_rates_org_id_idx', 'ownership_consolidation_entries_org_id_idx',
         'party_bank_accounts_org_id_idx', 'payment_events_org_id_idx', 'payment_file_deliveries_org_id_idx', 'payment_remittances_org_id_idx',
         'payment_terms_org_id_idx', 'psp_settlement_lines_org_id_idx', 'qbd_captures_org_id_idx', 'qbd_requests_org_id_idx',
         'qbd_sessions_org_id_idx', 'recognition_schedule_lines_org_id_idx', 'recognition_schedules_org_id_idx', 'reconciliation_matches_org_id_idx',
         'scheduler_outbox_terminal_audit_org_id_idx', 'script_runs_org_id_idx', 'serials_org_id_idx', 'stock_counts_org_id_idx',
         'subscription_events_org_id_idx', 'subscription_period_invoices_org_id_idx', 'tax_rates_org_id_idx', 'tax_report_lines_org_id_idx',
         'trades_org_id_idx', 'transfer_order_lines_org_id_idx', 'union_classifications_org_id_idx'
       )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx);
  END LOOP;
END
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS addresses_org_id_idx
  ON public.addresses USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_messages_org_id_idx
  ON public.ai_messages USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_rails_settings_org_id_idx
  ON public.ai_rails_settings USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_work_item_evidence_org_id_idx
  ON public.ai_work_item_evidence USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ap_capture_corrections_org_id_idx
  ON public.ap_capture_corrections USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ap_capture_events_org_id_idx
  ON public.ap_capture_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ap_capture_fields_org_id_idx
  ON public.ap_capture_fields USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS app_files_org_id_idx
  ON public.app_files USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS app_runs_org_id_idx
  ON public.app_runs USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_transfer_consolidation_entries_org_id_idx
  ON public.asset_transfer_consolidation_entries USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS bank_match_rules_org_id_idx
  ON public.bank_match_rules USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS bom_components_org_id_idx
  ON public.bom_components USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS change_set_items_org_id_idx
  ON public.change_set_items USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS charge_rate_components_org_id_idx
  ON public.charge_rate_components USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS close_blueprint_dependencies_org_id_idx
  ON public.close_blueprint_dependencies USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS close_blueprint_steps_org_id_idx
  ON public.close_blueprint_steps USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS close_events_org_id_idx
  ON public.close_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS close_exceptions_org_id_idx
  ON public.close_exceptions USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS close_signoffs_org_id_idx
  ON public.close_signoffs USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS close_task_evidence_org_id_idx
  ON public.close_task_evidence USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS cost_layer_consumptions_org_id_idx
  ON public.cost_layer_consumptions USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS cost_layer_weights_org_id_idx
  ON public.cost_layer_weights USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crew_time_batch_events_org_id_idx
  ON public.crew_time_batch_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_account_assignment_events_org_id_idx
  ON public.crm_account_assignment_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_account_stage_events_org_id_idx
  ON public.crm_account_stage_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_activity_participants_org_id_idx
  ON public.crm_activity_participants USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_opportunity_documents_org_id_idx
  ON public.crm_opportunity_documents USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_opportunity_lines_org_id_idx
  ON public.crm_opportunity_lines USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_opportunity_stage_events_org_id_idx
  ON public.crm_opportunity_stage_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_opportunity_team_members_org_id_idx
  ON public.crm_opportunity_team_members USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_sales_team_members_org_id_idx
  ON public.crm_sales_team_members USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS customer_roles_org_id_idx
  ON public.customer_roles USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS dunning_stages_org_id_idx
  ON public.dunning_stages USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS employee_roles_org_id_idx
  ON public.employee_roles USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS fair_value_prices_org_id_idx
  ON public.fair_value_prices USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_run_effects_org_id_idx
  ON public.flow_run_effects USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_scheduled_occurrences_org_id_idx
  ON public.flow_scheduled_occurrences USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hrm_calibration_sessions_org_id_idx
  ON public.hrm_calibration_sessions USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hrm_comp_cycle_budgets_org_id_idx
  ON public.hrm_comp_cycle_budgets USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hrm_comp_events_org_id_idx
  ON public.hrm_comp_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hrm_comp_statements_org_id_idx
  ON public.hrm_comp_statements USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hrm_competency_frameworks_org_id_idx
  ON public.hrm_competency_frameworks USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hrm_pay_information_requests_org_id_idx
  ON public.hrm_pay_information_requests USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS hrm_qualification_settings_org_id_idx
  ON public.hrm_qualification_settings USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS intercompany_pairs_org_id_idx
  ON public.intercompany_pairs USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_provisional_settlements_org_id_idx
  ON public.inventory_provisional_settlements USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS item_inventory_profiles_org_id_idx
  ON public.item_inventory_profiles USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS labor_rate_adjustment_targets_org_id_idx
  ON public.labor_rate_adjustment_targets USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS labor_rate_terms_org_id_idx
  ON public.labor_rate_terms USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS labor_rate_version_policies_org_id_idx
  ON public.labor_rate_version_policies USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS labor_rate_version_scopes_org_id_idx
  ON public.labor_rate_version_scopes USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS landed_cost_allocations_org_id_idx
  ON public.landed_cost_allocations USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS landed_cost_voucher_targets_org_id_idx
  ON public.landed_cost_voucher_targets USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS lots_org_id_idx
  ON public.lots USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS overhead_rates_org_id_idx
  ON public.overhead_rates USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ownership_consolidation_entries_org_id_idx
  ON public.ownership_consolidation_entries USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS party_bank_accounts_org_id_idx
  ON public.party_bank_accounts USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_events_org_id_idx
  ON public.payment_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_file_deliveries_org_id_idx
  ON public.payment_file_deliveries USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_remittances_org_id_idx
  ON public.payment_remittances USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_terms_org_id_idx
  ON public.payment_terms USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS psp_settlement_lines_org_id_idx
  ON public.psp_settlement_lines USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS qbd_captures_org_id_idx
  ON public.qbd_captures USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS qbd_requests_org_id_idx
  ON public.qbd_requests USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS qbd_sessions_org_id_idx
  ON public.qbd_sessions USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS recognition_schedule_lines_org_id_idx
  ON public.recognition_schedule_lines USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS recognition_schedules_org_id_idx
  ON public.recognition_schedules USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS reconciliation_matches_org_id_idx
  ON public.reconciliation_matches USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS scheduler_outbox_terminal_audit_org_id_idx
  ON public.scheduler_outbox_terminal_audit USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS script_runs_org_id_idx
  ON public.script_runs USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS serials_org_id_idx
  ON public.serials USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS stock_counts_org_id_idx
  ON public.stock_counts USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscription_events_org_id_idx
  ON public.subscription_events USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscription_period_invoices_org_id_idx
  ON public.subscription_period_invoices USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tax_rates_org_id_idx
  ON public.tax_rates USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tax_report_lines_org_id_idx
  ON public.tax_report_lines USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS trades_org_id_idx
  ON public.trades USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS transfer_order_lines_org_id_idx
  ON public.transfer_order_lines USING btree (org_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_classifications_org_id_idx
  ON public.union_classifications USING btree (org_id);
