-- Record the account each negative-stock issue charged at its provisional cost,
-- so the later receipt's cost true-up corrects that same account (COGS for a
-- sale, work in process for a manufacturing issue, scrap or adjustment for
-- other issues) instead of assuming cost of goods sold.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.inventory_provisional_costs
 ADD COLUMN offset_account_id uuid;
ALTER TABLE public.inventory_provisional_costs
 ADD CONSTRAINT inventory_provisional_costs_offset_account_fk
 FOREIGN KEY (org_id, offset_account_id) REFERENCES public.accounts (org_id, id);
COMMENT ON COLUMN public.inventory_provisional_costs.offset_account_id IS
 'Account the issue charged at provisional cost; its receipt cost true-up posts here. Null only for deficits recorded before the account was retained, which a receipt refuses to settle.';
