-- OpenBooks forward migration 0532_payout_reconciliation.
-- Month-end in-transit accruals for provider payouts: a payout initiated
-- (posted) but not yet tied to a bank deposit is reclassed out of the bank
-- account into the clearing account at period end, with an automatic reversal
-- dated the next period. One row per (batch, period-end date) with both
-- journal legs linked, so a rerun converges instead of double-accruing.
-- Deposit tie-out itself needs no storage: it is derived from the existing
-- bank reconciliation matches on the batch's bank-leg journal lines.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.psp_payout_accruals (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  -- Plain reference like psp_settlement_lines.batch_id: batches carry no
  -- UNIQUE(org_id, id) target for a composite key, so the engine locks the
  -- batch row by (org_id, id) before writing and checks the row count.
  batch_id uuid NOT NULL,
  accrual_date date NOT NULL,
  reversal_date date NOT NULL,
  amount numeric(19,4) NOT NULL,
  currency text NOT NULL,
  bank_account_id uuid,
  transit_account_id uuid,
  subsidiary_id uuid,
  accrual_entry_id uuid,
  reversal_entry_id uuid,
  status text NOT NULL DEFAULT 'accrued',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT psp_payout_accruals_batch_once UNIQUE (org_id, batch_id, accrual_date),
  CONSTRAINT psp_payout_accruals_status_chk CHECK (status IN ('accrued', 'reversed')),
  CONSTRAINT psp_payout_accruals_lifecycle_chk CHECK (
    ((status = 'accrued') AND (accrual_entry_id IS NOT NULL) AND (reversal_entry_id IS NULL))
    OR ((status = 'reversed') AND (accrual_entry_id IS NOT NULL)
        AND (reversal_entry_id IS NOT NULL) AND (reversal_entry_id <> accrual_entry_id))
  ),
  CONSTRAINT psp_payout_accruals_dates_chk CHECK (reversal_date > accrual_date)
);

CREATE INDEX psp_payout_accruals_batch ON public.psp_payout_accruals USING btree (batch_id);
CREATE INDEX psp_payout_accruals_org_status ON public.psp_payout_accruals USING btree (org_id, status);

ALTER TABLE public.psp_payout_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.psp_payout_accruals FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.psp_payout_accruals
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.psp_payout_accruals IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.psp_payout_accruals IS
  'Month-end in-transit accruals for provider payouts: one row per batch and period-end with the reclass journal and its next-period reversal linked.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('psp_payout_accruals', '0532_payout_reconciliation')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
