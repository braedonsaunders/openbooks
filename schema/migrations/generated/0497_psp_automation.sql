-- OpenBooks forward migration 0497_psp_automation.
--
-- PSP settlement and refund/dispute automation: admit Shopify Payments and
-- PayPal settlement imports, carry provider exchange-rate evidence on
-- settlement batches, automate provider refund/dispute accounting behind a
-- per-provider review policy, and track refunds and disputes with the
-- documents they post.
--
-- Additive and widening only. Every existing row already satisfies the wider
-- provider checks and the new FX evidence check (all added columns start
-- null, except refund_policy and pull_enabled which default closed/automatic).
-- No tenant row is read, rewritten, or deleted.
--
-- payment_disputes deliberately carries no party column: a dispute links its
-- customer through attempt_id and receipt_document_id, so party merges and
-- subject-export coverage need no new decision for this table.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Shopify Payments and PayPal join the settlement provider set. Existing rows
-- keep their providers; the wider check admits every row the old one did.
ALTER TABLE public.psp_provider_configs DROP CONSTRAINT IF EXISTS psp_provider_configs_provider_chk;
ALTER TABLE public.psp_provider_configs ADD CONSTRAINT psp_provider_configs_provider_chk
  CHECK (provider = ANY (ARRAY['stripe'::text, 'adyen'::text, 'gocardless'::text, 'recurly'::text, 'chargebee'::text, 'shopify_payments'::text, 'paypal'::text]));

ALTER TABLE public.psp_settlement_batches DROP CONSTRAINT IF EXISTS psp_settlement_batches_provider_chk;
ALTER TABLE public.psp_settlement_batches ADD CONSTRAINT psp_settlement_batches_provider_chk
  CHECK (provider = ANY (ARRAY['stripe'::text, 'adyen'::text, 'gocardless'::text, 'recurly'::text, 'chargebee'::text, 'shopify_payments'::text, 'paypal'::text]));

-- Per-provider refund/dispute automation policy and pull state.
ALTER TABLE public.psp_provider_configs
  ADD COLUMN IF NOT EXISTS refund_policy text NOT NULL DEFAULT 'automatic',
  ADD COLUMN IF NOT EXISTS pull_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_pull_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS default_disputed_funds_account_id uuid,
  ADD COLUMN IF NOT EXISTS default_chargeback_loss_account_id uuid,
  ADD COLUMN IF NOT EXISTS default_dispute_fee_account_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'psp_provider_configs_refund_policy_chk') THEN
    ALTER TABLE ONLY public.psp_provider_configs
      ADD CONSTRAINT psp_provider_configs_refund_policy_chk CHECK ((refund_policy = ANY (ARRAY['automatic'::text, 'review'::text])));
  END IF;
END
$$;

COMMENT ON COLUMN public.psp_provider_configs.refund_policy IS
  'Provider refund/dispute automation policy: automatic posts accounting immediately, review parks events for operator approval. Defaults to automatic; existing configs keep prior behaviour through the automatic path.';
COMMENT ON COLUMN public.psp_provider_configs.pull_enabled IS
  'Scheduled payout fetch for this provider. Each fetched payout becomes a settlement batch, idempotent on (provider, external ref).';
COMMENT ON COLUMN public.psp_provider_configs.last_pull_at IS
  'Last successful scheduled payout fetch for this provider.';
COMMENT ON COLUMN public.psp_provider_configs.default_disputed_funds_account_id IS
  'Clearing account holding funds under dispute until the dispute resolves.';
COMMENT ON COLUMN public.psp_provider_configs.default_chargeback_loss_account_id IS
  'Expense account for lost disputes.';
COMMENT ON COLUMN public.psp_provider_configs.default_dispute_fee_account_id IS
  'Expense account for provider dispute fees.';

-- Settlement FX evidence: the charges currency, the provider rate from
-- charges to payout currency, and — when the payout itself is foreign to the
-- posting entity — the payout-to-base rate. All legs convert with exact
-- decimal math; a missing rate is refused naming the column to supply.
ALTER TABLE public.psp_settlement_batches
  ADD COLUMN IF NOT EXISTS source_currency text,
  ADD COLUMN IF NOT EXISTS conversion_rate numeric(19,10),
  ADD COLUMN IF NOT EXISTS conversion_rate_source text,
  ADD COLUMN IF NOT EXISTS payout_rate numeric(19,10),
  ADD COLUMN IF NOT EXISTS payout_rate_source text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'psp_settlement_batches_fx_evidence_chk') THEN
    ALTER TABLE ONLY public.psp_settlement_batches
      ADD CONSTRAINT psp_settlement_batches_fx_evidence_chk CHECK (
        (source_currency IS NULL AND conversion_rate IS NULL AND conversion_rate_source IS NULL)
        OR (source_currency IS NOT NULL AND conversion_rate IS NOT NULL AND conversion_rate > 0 AND conversion_rate_source IS NOT NULL)
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'psp_settlement_batches_payout_rate_chk') THEN
    ALTER TABLE ONLY public.psp_settlement_batches
      ADD CONSTRAINT psp_settlement_batches_payout_rate_chk CHECK (payout_rate IS NULL OR payout_rate > 0);
  END IF;
END
$$;

COMMENT ON COLUMN public.psp_settlement_batches.source_currency IS
  'Charges currency when it differs from the batch (payout) currency; null for single-currency batches.';
COMMENT ON COLUMN public.psp_settlement_batches.conversion_rate IS
  'Provider-evidenced rate: units of batch currency per 1 unit of source currency. Required whenever source_currency is set.';
COMMENT ON COLUMN public.psp_settlement_batches.conversion_rate_source IS
  'Provenance of conversion_rate (for example stripe:balance_transaction, paypal:payout, operator:manual).';
COMMENT ON COLUMN public.psp_settlement_batches.payout_rate IS
  'Rate from payout currency to the posting entity base currency: base units per 1 unit of batch currency. Required when the payout currency differs from base.';
COMMENT ON COLUMN public.psp_settlement_batches.payout_rate_source IS
  'Provenance of payout_rate (for example provider:payout, fx:spot, operator:manual).';

-- Dispute-first markers can park dispute events as well as refunds now.
ALTER TABLE public.payment_pending_clawbacks DROP CONSTRAINT IF EXISTS payment_pending_clawbacks_status_chk;
ALTER TABLE public.payment_pending_clawbacks ADD CONSTRAINT payment_pending_clawbacks_status_chk
  CHECK ((event_status = ANY (ARRAY['refunded'::text, 'disputed'::text])));

-- Provider refunds and disputes with the documents they post. One row per
-- provider event: the unique key is the automation idempotency lock, so a
-- redelivered event converges instead of posting twice. Review-policy events
-- wait here as pending_review until an operator approves or rejects them.
CREATE TABLE IF NOT EXISTS public.payment_disputes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    attempt_id uuid,
    receipt_document_id uuid,
    invoice_document_id uuid,
    currency text NOT NULL,
    amount numeric(19,4) NOT NULL,
    fee_amount numeric(19,4) NOT NULL DEFAULT 0,
    provider_ref text,
    reason text,
    status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
    documents_posted jsonb NOT NULL DEFAULT '[]'::jsonb,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT payment_disputes_kind_chk CHECK ((kind = ANY (ARRAY['refund'::text, 'dispute'::text]))),
    CONSTRAINT payment_disputes_status_chk CHECK ((status = ANY (ARRAY['pending_review'::text, 'posted'::text, 'rejected'::text, 'opened'::text, 'won'::text, 'lost'::text]))),
    CONSTRAINT payment_disputes_event_nonblank CHECK ((length(btrim(provider_event_id)) > 0)),
    CONSTRAINT payment_disputes_amount_nonnegative CHECK ((amount >= 0)),
    CONSTRAINT payment_disputes_fee_nonnegative CHECK ((fee_amount >= 0))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_disputes_pkey') THEN
    ALTER TABLE ONLY public.payment_disputes ADD CONSTRAINT payment_disputes_pkey PRIMARY KEY (id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_disputes_event_key') THEN
    ALTER TABLE ONLY public.payment_disputes
      ADD CONSTRAINT payment_disputes_event_key UNIQUE (org_id, provider, provider_event_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS payment_disputes_status_idx ON public.payment_disputes (org_id, status);
CREATE INDEX IF NOT EXISTS payment_disputes_attempt_idx ON public.payment_disputes (org_id, attempt_id);

ALTER TABLE ONLY public.payment_disputes FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'payment_disputes'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.payment_disputes
      USING (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      )
      WITH CHECK (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      );
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.payment_disputes IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.payment_disputes IS
  'Provider refund/dispute automation ledger: one row per provider event with status history and posted documents. Redeliveries converge on the event key.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('payment_disputes', '0497_psp_automation')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
