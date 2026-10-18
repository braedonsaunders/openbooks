-- The built-in Approver reads expense reports, as it reads every other
-- subledger it reviews, so it can open the reports it is asked to approve.
-- Entering, posting and paying them stays with their own grants. The
-- built-in role descriptions name the expense access those roles now hold.
-- Backfill: existing built-in Approver roles gain expenses.read unless they
-- already hold it or every permission; built-in role descriptions are
-- refreshed to the catalogue text. No custom role is changed.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

UPDATE public.app_roles SET permissions = permissions || '["expenses.read"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'approver'
   AND NOT (permissions ? 'expenses.read' OR permissions ? 'expenses.*' OR permissions ? '*');

UPDATE public.app_roles SET description = 'Manages manufacturing masters and shop-floor work, and posts inventory movements. Files their own expense reports. Cannot reverse inventory postings or see the ledger.', updated_at = now()
 WHERE is_built_in AND key = 'production' AND description IS DISTINCT FROM 'Manages manufacturing masters and shop-floor work, and posts inventory movements. Files their own expense reports. Cannot reverse inventory postings or see the ledger.';
UPDATE public.app_roles SET description = 'Reviews and decides approval requests, including period reopen requests, with read access to the ledger, subledgers and reports. Reads expense reports for review. Cannot enter, post or pay transactions.', updated_at = now()
 WHERE is_built_in AND key = 'approver' AND description IS DISTINCT FROM 'Reviews and decides approval requests, including period reopen requests, with read access to the ledger, subledgers and reports. Reads expense reports for review. Cannot enter, post or pay transactions.';
UPDATE public.app_roles SET description = 'Runs the sales team: accounts, activities, opportunities, quotas and forecasts, and drafts invoices and cash sales. Files their own expense reports. Cannot post, collect payments or see the ledger.', updated_at = now()
 WHERE is_built_in AND key = 'sales_manager' AND description IS DISTINCT FROM 'Runs the sales team: accounts, activities, opportunities, quotas and forecasts, and drafts invoices and cash sales. Files their own expense reports. Cannot post, collect payments or see the ledger.';
UPDATE public.app_roles SET description = 'Works assigned accounts, activities, opportunities and personal forecasts, and drafts invoices and cash sales. Files their own expense reports. Cannot post, collect payments or see the ledger.', updated_at = now()
 WHERE is_built_in AND key = 'sales_rep' AND description IS DISTINCT FROM 'Works assigned accounts, activities, opportunities and personal forecasts, and drafts invoices and cash sales. Files their own expense reports. Cannot post, collect payments or see the ledger.';
UPDATE public.app_roles SET description = 'Raises purchase orders and receives goods against them, with read access to vendors, items and payables. Files their own expense reports. Cannot post or pay bills, post inventory, or see banking or the ledger.', updated_at = now()
 WHERE is_built_in AND key = 'buyer' AND description IS DISTINCT FROM 'Raises purchase orders and receives goods against them, with read access to vendors, items and payables. Files their own expense reports. Cannot post or pay bills, post inventory, or see banking or the ledger.';
UPDATE public.app_roles SET description = 'Rings up, posts and refunds cash sales at the till and the register, opens and closes the register drawer, drops till cash to the bank, and looks up gift card balances. Files their own expense reports. Cannot override prices, see invoices, banking or the ledger.', updated_at = now()
 WHERE is_built_in AND key = 'cashier' AND description IS DISTINCT FROM 'Rings up, posts and refunds cash sales at the till and the register, opens and closes the register drawer, drops till cash to the bank, and looks up gift card balances. Files their own expense reports. Cannot override prices, see invoices, banking or the ledger.';
UPDATE public.app_roles SET description = 'Logs their own time, follows projects and drafts customer invoices for approval. Files their own expense reports. Cannot see coworkers'' time, post invoices, take or make payments, or see banking or the ledger.', updated_at = now()
 WHERE is_built_in AND key = 'project_coordinator' AND description IS DISTINCT FROM 'Logs their own time, follows projects and drafts customer invoices for approval. Files their own expense reports. Cannot see coworkers'' time, post invoices, take or make payments, or see banking or the ledger.';
