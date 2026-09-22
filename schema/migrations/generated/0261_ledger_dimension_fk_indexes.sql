-- OpenBooks forward migration 0261_ledger_dimension_fk_indexes.
--
-- The dimension foreign keys on the three big ledger tables had no backing
-- index: journal_lines (department_id, class_id, location_id, tax_code_id,
-- payment_card_id, equipment_unit_id), document_lines (item_id, tax_code_id,
-- account_id, employee_id, equipment_unit_id, rate_version_id,
-- recovery_account_id, stock_location_id, subsidiary_id, tax_group_id,
-- time_type_id), and time_entries (item_id, project_task_id, department_id,
-- bill_rate_book_id, bill_rate_line_id, bill_rate_version_id,
-- labor_cost_rate_id, cost_rate_subsidiary_id, cost_rate_currency,
-- wage_currency, time_type_id). Deleting a department — or a sandbox
-- refresh / org purge touching any referenced row — fires one FK check per
-- referencing row, and with no index each check scans all of the org's
-- lines (millions on the perf tenant). Department/class P&L filters had the
-- same gap, falling back to the posting-date index plus a filter.
--
-- Every index below is composite (org_id, fk): FK checks are org-agnostic
-- equality probes that use the trailing column, while org-scoped reads seek
-- the leading one. Columns that double as query-filter dimensions
-- (department/class/location on lines; item/tax/account on document lines;
-- item/task/department on time entries) are FULL indexes. The rest are
-- sparse provenance pointers, so they carry WHERE (fk IS NOT NULL) — a
-- parameterized `WHERE fk = $1` (the FK-check shape) and an org-scoped
-- equality filter both provably use the partial form, while NULL-heavy
-- tenants skip indexing their NULLs entirely.
--
-- Prod journal_lines holds ~3.7M+ rows, so these build with CREATE INDEX
-- CONCURRENTLY, which PostgreSQL refuses inside a transaction block: this
-- file declares `-- openbooks: no-transaction` and the runner executes it
-- statement by statement with a bounded session lock_timeout. The contract
-- that makes a mid-file failure retry-safe: every statement is idempotent
-- (IF NOT EXISTS throughout), and the DO block up front drops this file's
-- own INVALID indexes — a failed CONCURRENTLY build leaves one behind, and
-- IF NOT EXISTS would otherwise skip the name forever, silently keeping the
-- missing index. Plain (non-concurrent) DROP inside the DO block is safe:
-- an INVALID index answers no query, so its brief exclusive lock contends
-- with nothing.
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

-- Retry safety: drop our own INVALID indexes before rebuilding. A failed
-- CONCURRENTLY build leaves the name present but unusable, and IF NOT
-- EXISTS below would then skip it forever.
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
         'jl_org_department', 'jl_org_class', 'jl_org_location',
         'jl_org_tax_code', 'jl_org_payment_card', 'jl_org_equipment_unit',
         'doc_lines_item', 'doc_lines_tax_code', 'doc_lines_account',
         'doc_lines_employee', 'doc_lines_equipment_unit',
         'doc_lines_rate_version', 'doc_lines_recovery_account',
         'doc_lines_stock_location', 'doc_lines_subsidiary',
         'doc_lines_tax_group', 'doc_lines_time_type',
         'time_entries_item', 'time_entries_project_task',
         'time_entries_department', 'time_entries_bill_rate_book',
         'time_entries_bill_rate_line', 'time_entries_bill_rate_version',
         'time_entries_labor_cost_rate', 'time_entries_cost_rate_subsidiary',
         'time_entries_cost_rate_currency', 'time_entries_wage_currency',
         'time_entries_time_type'
       )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx);
  END LOOP;
END
$$;

-- journal_lines: dimension FKs. department/class/location are P&L filter
-- dimensions (full); tax/card/equipment ride a few line kinds (partial).
CREATE INDEX CONCURRENTLY IF NOT EXISTS jl_org_department
  ON public.journal_lines USING btree (org_id, department_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS jl_org_class
  ON public.journal_lines USING btree (org_id, class_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS jl_org_location
  ON public.journal_lines USING btree (org_id, location_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS jl_org_tax_code
  ON public.journal_lines USING btree (org_id, tax_code_id)
  WHERE (tax_code_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS jl_org_payment_card
  ON public.journal_lines USING btree (org_id, payment_card_id)
  WHERE (payment_card_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS jl_org_equipment_unit
  ON public.journal_lines USING btree (org_id, equipment_unit_id)
  WHERE (equipment_unit_id IS NOT NULL);

-- document_lines: item/tax/account are report filters (full); the rest are
-- sparse lineage pointers (partial). document_id, party_id, project_id,
-- time_entry_id, billed_by_line_id and field_ticket_id are already covered.
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_item
  ON public.document_lines USING btree (org_id, item_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_tax_code
  ON public.document_lines USING btree (org_id, tax_code_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_account
  ON public.document_lines USING btree (org_id, account_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_employee
  ON public.document_lines USING btree (org_id, employee_id)
  WHERE (employee_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_equipment_unit
  ON public.document_lines USING btree (org_id, equipment_unit_id)
  WHERE (equipment_unit_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_rate_version
  ON public.document_lines USING btree (org_id, rate_version_id)
  WHERE (rate_version_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_recovery_account
  ON public.document_lines USING btree (org_id, recovery_account_id)
  WHERE (recovery_account_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_stock_location
  ON public.document_lines USING btree (org_id, stock_location_id)
  WHERE (stock_location_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_subsidiary
  ON public.document_lines USING btree (org_id, subsidiary_id)
  WHERE (subsidiary_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_tax_group
  ON public.document_lines USING btree (org_id, tax_group_id)
  WHERE (tax_group_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_lines_time_type
  ON public.document_lines USING btree (org_id, time_type_id)
  WHERE (time_type_id IS NOT NULL);

-- time_entries: item/task/department are billing and labor-report filters
-- (full); rate provenance and type pointers are sparse (partial).
-- employee_party_id and project_id are already covered as leading columns.
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_item
  ON public.time_entries USING btree (org_id, item_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_project_task
  ON public.time_entries USING btree (org_id, project_task_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_department
  ON public.time_entries USING btree (org_id, department_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_bill_rate_book
  ON public.time_entries USING btree (org_id, bill_rate_book_id)
  WHERE (bill_rate_book_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_bill_rate_line
  ON public.time_entries USING btree (org_id, bill_rate_line_id)
  WHERE (bill_rate_line_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_bill_rate_version
  ON public.time_entries USING btree (org_id, bill_rate_version_id)
  WHERE (bill_rate_version_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_labor_cost_rate
  ON public.time_entries USING btree (org_id, labor_cost_rate_id)
  WHERE (labor_cost_rate_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_cost_rate_subsidiary
  ON public.time_entries USING btree (org_id, cost_rate_subsidiary_id)
  WHERE (cost_rate_subsidiary_id IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_cost_rate_currency
  ON public.time_entries USING btree (org_id, cost_rate_currency)
  WHERE (cost_rate_currency IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_wage_currency
  ON public.time_entries USING btree (org_id, wage_currency)
  WHERE (wage_currency IS NOT NULL);
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_time_type
  ON public.time_entries USING btree (org_id, time_type_id)
  WHERE (time_type_id IS NOT NULL);
