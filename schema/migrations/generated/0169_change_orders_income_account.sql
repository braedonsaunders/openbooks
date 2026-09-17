-- OpenBooks forward migration 0169_change_orders_income_account.
--
-- F-t03-002 residual: an owner change order approved without a target
-- schedule line creates a bare SOV line with no income account, so the line
-- is unpostable once billed ("Line ... has no income account") until someone
-- edits it by hand. Change orders now carry the income account their
-- approval lands on the new schedule line: the CO dialog offers the
-- income-account picker (defaulted to the org project-revenue control
-- account), addChangeOrder pins and stores it, and approveChangeOrder
-- carries it onto the created SOV line (falling back to the org default
-- when the CO predates this column or was saved without one).
--
-- Forward-only additive change: one nullable column plus its tenant-coherent
-- foreign key (composite on org, deferrable, matching the sibling income
-- pins), and the governed read view re-created to carry the column.
-- Existing rows keep NULL and resolve through the same fallback at approval
-- time, so no backfill runs here.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- 1. Owner change orders carry the income account for the schedule line
--    their approval creates.
ALTER TABLE public.change_orders
  ADD COLUMN IF NOT EXISTS income_account_id uuid;

ALTER TABLE public.change_orders DROP CONSTRAINT IF EXISTS change_orders_income_org_fk;
ALTER TABLE public.change_orders ADD CONSTRAINT change_orders_income_org_fk
  FOREIGN KEY (org_id, income_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE;

COMMENT ON COLUMN public.change_orders.income_account_id IS
  'Income account the approval lands on the created SOV line when the change order has no target schedule line (0169; nullable for pre-migration rows, which resolve through the org project-revenue control account at approval time)';

-- 2. Governed read view carries the new column (same SELECT-only shape).
DROP VIEW IF EXISTS openbooks_query.change_orders;
CREATE VIEW openbooks_query.change_orders WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    project_id,
    number,
    description,
    status,
    amount,
    approved_on,
    created_at,
    created_by,
    updated_at,
    updated_by,
    approved_by,
    target_sov_line_id,
    income_account_id
   FROM public.change_orders
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.change_orders TO openbooks_read;
