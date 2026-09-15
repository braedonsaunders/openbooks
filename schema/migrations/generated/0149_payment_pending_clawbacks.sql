-- OpenBooks forward migration 0149_payment_pending_clawbacks.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- A refund/chargeback webhook can beat its own settlement event: the intent
-- id is only persisted onto the payment_attempt from the completed checkout
-- session, so an out-of-order refund cannot resolve to an attempt and was
-- dropped as unknown_attempt (a 200 that loses the return forever). This
-- migration parks such events as pending-clawback markers keyed by
-- (org_id, provider, intent_ref); the later succeeded event consumes its
-- marker exactly once (conditional UPDATE on consumed_at IS NULL is the
-- once-only lock) and writes the controller-facing clawback audit note.
-- Redeliveries upsert idempotently on the marker key; a concurrent consumer
-- loses the conditional update and sees no row.
--
-- Additive, ledger-tracked, no history reinterpretation. See the refund-first
-- contract in engine/src/payment-acceptance.ts.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.payment_pending_clawbacks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    provider text NOT NULL,
    intent_ref text NOT NULL,
    event_status text NOT NULL,
    event_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    consumed_attempt_id uuid,
    CONSTRAINT payment_pending_clawbacks_status_chk CHECK ((event_status = 'refunded'::text))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_pending_clawbacks_pkey'
  ) THEN
    ALTER TABLE ONLY public.payment_pending_clawbacks
      ADD CONSTRAINT payment_pending_clawbacks_pkey PRIMARY KEY (id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_pending_clawbacks_intent_key'
  ) THEN
    ALTER TABLE ONLY public.payment_pending_clawbacks
      ADD CONSTRAINT payment_pending_clawbacks_intent_key
      UNIQUE (org_id, provider, intent_ref);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_pending_clawbacks_consumed_attempt_fk'
  ) THEN
    ALTER TABLE ONLY public.payment_pending_clawbacks
      ADD CONSTRAINT payment_pending_clawbacks_consumed_attempt_fk
      FOREIGN KEY (consumed_attempt_id) REFERENCES public.payment_attempts(id) DEFERRABLE;
  END IF;
END
$$;

ALTER TABLE ONLY public.payment_pending_clawbacks FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'payment_pending_clawbacks'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.payment_pending_clawbacks
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

COMMENT ON POLICY org_isolation ON public.payment_pending_clawbacks IS 'openbooks:org_isolation:v1';

ALTER TABLE public.payment_pending_clawbacks ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.payment_pending_clawbacks IS
  'Refund-first markers: out-of-order refund/chargeback webhooks parked by intent until the settlement event consumes them exactly once.';
