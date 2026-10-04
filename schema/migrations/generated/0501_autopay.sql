-- Autopay: stored payment methods, autopay enrollments, collection attempts,
-- retry schedule and final action on the dunning policy, and a suspended
-- subscription state for collections-driven suspension.
--
-- New tables carry org_id with ENABLE + FORCE RLS and the org_isolation
-- policy like every tenant table. No existing rows are read or rewritten:
-- the dunning-policy columns are additive with safe defaults, and the
-- subscriptions status check only widens to admit 'suspended'.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.customer_payment_methods (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 party_id uuid NOT NULL REFERENCES public.parties(id),
 provider text NOT NULL,
 provider_customer_id text,
 provider_method_id text,
 brand text,
 last4 text,
 exp_month smallint,
 exp_year smallint,
 mandate_reference text,
 is_default boolean DEFAULT false NOT NULL,
 status text DEFAULT 'active'::text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 UNIQUE(org_id,id),
 CONSTRAINT customer_payment_methods_provider_chk CHECK ((provider = ANY (ARRAY['stripe'::text, 'adyen'::text, 'gocardless'::text]))),
 CONSTRAINT customer_payment_methods_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'removed'::text]))),
 CONSTRAINT customer_payment_methods_expiry_chk CHECK (((exp_month IS NULL AND exp_year IS NULL) OR (exp_month BETWEEN 1 AND 12 AND exp_year BETWEEN 2000 AND 2100)))
);
-- One default method per customer: the scan charges the default, so two
-- defaults would make the charge target ambiguous.
CREATE UNIQUE INDEX customer_payment_methods_one_default ON public.customer_payment_methods(org_id, party_id) WHERE is_default;
CREATE INDEX customer_payment_methods_org_party ON public.customer_payment_methods(org_id, party_id);
ALTER TABLE public.customer_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_payment_methods FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.customer_payment_methods
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.customer_payment_methods IS 'openbooks:org_isolation:v1';

CREATE TABLE public.autopay_enrollments (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 party_id uuid NOT NULL REFERENCES public.parties(id),
 subscription_id uuid REFERENCES public.subscriptions(id),
 payment_method_id uuid REFERENCES public.customer_payment_methods(id) ON DELETE SET NULL,
 status text DEFAULT 'active'::text NOT NULL,
 charge_on_issue boolean DEFAULT false NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 UNIQUE(org_id,id),
 CONSTRAINT autopay_enrollments_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'canceled'::text])))
);
-- One live customer-level enrollment per customer and one live enrollment
-- per subscription: two active rows would charge the same invoice twice.
CREATE UNIQUE INDEX autopay_enrollments_one_customer ON public.autopay_enrollments(org_id, party_id) WHERE subscription_id IS NULL AND status = 'active';
CREATE UNIQUE INDEX autopay_enrollments_one_subscription ON public.autopay_enrollments(org_id, subscription_id) WHERE subscription_id IS NOT NULL AND status = 'active';
CREATE INDEX autopay_enrollments_org_party ON public.autopay_enrollments(org_id, party_id);
ALTER TABLE public.autopay_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autopay_enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.autopay_enrollments
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.autopay_enrollments IS 'openbooks:org_isolation:v1';

CREATE TABLE public.collection_attempts (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 invoice_id uuid NOT NULL REFERENCES public.documents(id),
 enrollment_id uuid REFERENCES public.autopay_enrollments(id),
 payment_method_id uuid REFERENCES public.customer_payment_methods(id),
 amount numeric(19,4) NOT NULL,
 currency text NOT NULL,
 provider text NOT NULL,
 provider_ref text,
 receipt_document_id uuid REFERENCES public.documents(id),
 status text DEFAULT 'initiated'::text NOT NULL,
 decline_code text,
 decline_kind text,
 retry_position integer DEFAULT 0 NOT NULL,
 next_retry_on date,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 UNIQUE(org_id,id),
 CONSTRAINT collection_attempts_status_chk CHECK ((status = ANY (ARRAY['initiated'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text]))),
 CONSTRAINT collection_attempts_decline_kind_chk CHECK ((decline_kind IS NULL OR decline_kind = ANY (ARRAY['hard'::text, 'soft'::text]))),
 CONSTRAINT collection_attempts_amount_chk CHECK ((amount > 0))
);
-- Idempotency per (invoice, schedule position): a retried scheduler tick
-- reuses the existing attempt instead of charging twice.
CREATE UNIQUE INDEX collection_attempts_one_per_position ON public.collection_attempts(org_id, invoice_id, retry_position);
CREATE INDEX collection_attempts_org_invoice ON public.collection_attempts(org_id, invoice_id);
CREATE INDEX collection_attempts_retry_due ON public.collection_attempts(org_id, next_retry_on) WHERE status = 'failed';
ALTER TABLE public.collection_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.collection_attempts
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.collection_attempts IS 'openbooks:org_isolation:v1';

-- Retry schedule and final action live on the dunning policy: offsets are
-- days after the previous attempt, the final action runs when they run out.
ALTER TABLE public.dunning_policies
 ADD COLUMN autopay_retry_offsets_days integer[] NOT NULL DEFAULT '{}',
 ADD COLUMN autopay_final_action text NOT NULL DEFAULT 'none';
ALTER TABLE public.dunning_policies
 ADD CONSTRAINT dunning_policies_autopay_final_action_chk CHECK ((autopay_final_action = ANY (ARRAY['none'::text, 'suspend'::text, 'cancel'::text])));

-- Collections-driven suspension: the subscription stops billing (the billing
-- scan only picks up 'active') but the contract stays for reactivation.
-- Distinct from operator 'paused', which carries paused_on/resume_on dates.
ALTER TABLE public.subscriptions DROP CONSTRAINT subscriptions_status;
ALTER TABLE public.subscriptions
 ADD CONSTRAINT subscriptions_status CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'suspended'::text, 'canceled'::text])));

insert into public.openbooks_query_catalog_relations (relation, added_in)
values ('customer_payment_methods', '0501_autopay'),
       ('autopay_enrollments', '0501_autopay'),
       ('collection_attempts', '0501_autopay')
on conflict (relation) do nothing; -- expected on replay
select public.openbooks_refresh_query_catalog();
