-- OpenBooks forward migration 0502_revenue_contract_scope.
-- A revenue contract may span a sales order or a subscription billed across
-- several invoices, with billed consideration accumulated on the contract and
-- every billing recorded in revenue_contract_billings. Existing contracts
-- backfill to invoice scope with consideration equal to their transaction
-- price, so posted history reads exactly as before.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.revenue_contracts
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'invoice',
  ADD COLUMN IF NOT EXISTS source_document_id uuid,
  ADD COLUMN IF NOT EXISTS subscription_id uuid,
  ADD COLUMN IF NOT EXISTS total_consideration numeric(19,4) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS modification_seq integer NOT NULL DEFAULT 0;

-- Billed consideration for contracts created before scoped billing existed is
-- the contract's own transaction price: one contract per invoice by
-- construction, so nothing billed is missing and nothing is double counted.
UPDATE public.revenue_contracts
   SET total_consideration = total_transaction_price
 WHERE total_consideration = '0';

ALTER TABLE public.revenue_contracts
  DROP CONSTRAINT IF EXISTS revenue_contracts_scope_valid;
ALTER TABLE public.revenue_contracts
  ADD CONSTRAINT revenue_contracts_scope_valid
  CHECK (scope IN ('invoice', 'order', 'subscription'));
ALTER TABLE public.revenue_contracts
  DROP CONSTRAINT IF EXISTS revenue_contracts_scope_subject;
ALTER TABLE public.revenue_contracts
  ADD CONSTRAINT revenue_contracts_scope_subject CHECK (
    (scope = 'invoice' AND source_document_id IS NULL AND subscription_id IS NULL)
    OR (scope = 'order' AND source_document_id IS NOT NULL AND subscription_id IS NULL)
    OR (scope = 'subscription' AND source_document_id IS NULL AND subscription_id IS NOT NULL)
  );
ALTER TABLE public.revenue_contracts
  DROP CONSTRAINT IF EXISTS revenue_contracts_consideration_nonnegative;
ALTER TABLE public.revenue_contracts
  ADD CONSTRAINT revenue_contracts_consideration_nonnegative
  CHECK (total_consideration >= 0);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_contract_source_tenant') THEN
    ALTER TABLE public.revenue_contracts
      ADD CONSTRAINT revenue_contract_source_tenant
      FOREIGN KEY (org_id, source_document_id) REFERENCES public.documents (org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_contract_subscription_tenant') THEN
    ALTER TABLE public.revenue_contracts
      ADD CONSTRAINT revenue_contract_subscription_tenant
      FOREIGN KEY (org_id, subscription_id) REFERENCES public.subscriptions (org_id, id);
  END IF;
END $$;

-- One row per billing document posted against a contract: the billed leg of
-- the contract asset/liability position. An invoice bills exactly one
-- contract, so the document side is unique; replay of a posted billing
-- reconciles to its existing row instead of recording twice.
CREATE TABLE public.revenue_contract_billings (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  document_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  billed_on date NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT revenue_contract_billings_pkey PRIMARY KEY (id),
  CONSTRAINT revenue_contract_billings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT revenue_contract_billings_document_unique UNIQUE (org_id, document_id),
  CONSTRAINT revenue_contract_billings_amount_nonnegative CHECK (amount >= 0),
  CONSTRAINT revenue_contract_billings_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT revenue_contract_billings_contract_tenant
    FOREIGN KEY (org_id, contract_id) REFERENCES public.revenue_contracts (org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT revenue_contract_billings_document_tenant
    FOREIGN KEY (org_id, document_id) REFERENCES public.documents (org_id, id) DEFERRABLE
);
CREATE INDEX IF NOT EXISTS revenue_contract_billings_contract
  ON public.revenue_contract_billings (org_id, contract_id);

ALTER TABLE public.revenue_contract_billings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue_contract_billings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.revenue_contract_billings
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.revenue_contract_billings IS 'openbooks:org_isolation:v1';

-- New columns append after the existing ones: replacing the view with a
-- different column order is rejected, so the historical order is preserved.
CREATE OR REPLACE VIEW openbooks_query.revenue_contracts WITH (security_barrier = 'true') AS
  SELECT id, org_id, customer_id, contract_number, status, starts_on, ends_on,
    total_transaction_price, memo, created_at, created_by, updated_at, updated_by,
    currency, project_id, pricing, idempotency_key, subsidiary_id, revision,
    last_change_id, parent_contract_id, scope, source_document_id,
    subscription_id, total_consideration, modification_seq
    FROM public.revenue_contracts
   WHERE (org_id = public.openbooks_query_org_id());

CREATE OR REPLACE VIEW openbooks_query.revenue_contract_billings WITH (security_barrier = 'true') AS
  SELECT id, org_id, contract_id, document_id, amount, billed_on,
    created_at, created_by, updated_at, updated_by
    FROM public.revenue_contract_billings
   WHERE (org_id = public.openbooks_query_org_id());

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('revenue_contract_billings', '0502_revenue_contract_scope')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
