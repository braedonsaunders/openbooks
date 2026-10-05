-- OpenBooks forward migration 0506_quote_to_cash.
-- Quote-to-cash: subscription terms and ramp steps priced on a quote, generic
-- e-signature requests over any subject table, and the quote a subscription
-- was activated from (one activation per quote).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Subscription terms priced on one quote line: the plan (and, for
-- contract-grade lifecycles, its version) the line sells, how many months the
-- term runs, when the term starts, and whether it bills in advance or arrears.
-- A co-term line rides the named subscription instead of opening its own term.
CREATE TABLE public.quote_subscription_terms (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  quote_line_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  plan_version_id uuid,
  term_months integer NOT NULL,
  start_rule text DEFAULT 'quote_date' NOT NULL,
  billing_timing text DEFAULT 'advance' NOT NULL,
  coterm_subscription_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT quote_subscription_terms_pkey PRIMARY KEY (id),
  CONSTRAINT quote_subscription_terms_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT quote_subscription_terms_line_unique UNIQUE (org_id, quote_id, quote_line_id),
  CONSTRAINT quote_subscription_terms_months_valid
    CHECK (term_months >= 1 AND term_months <= 120),
  CONSTRAINT quote_subscription_terms_start_rule_valid
    CHECK (start_rule IN ('quote_date', 'first_of_next_month', 'custom')),
  CONSTRAINT quote_subscription_terms_timing_valid
    CHECK (billing_timing IN ('advance', 'arrears')),
  CONSTRAINT quote_subscription_terms_quote_fk
    FOREIGN KEY (org_id, quote_id) REFERENCES public.documents(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT quote_subscription_terms_line_fk
    FOREIGN KEY (org_id, quote_line_id) REFERENCES public.document_lines(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT quote_subscription_terms_plan_fk
    FOREIGN KEY (org_id, plan_id) REFERENCES public.subscription_plans(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT quote_subscription_terms_version_fk
    FOREIGN KEY (org_id, plan_version_id) REFERENCES public.subscription_plan_versions(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT quote_subscription_terms_coterm_fk
    FOREIGN KEY (org_id, coterm_subscription_id) REFERENCES public.subscriptions(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT quote_subscription_terms_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

ALTER TABLE public.quote_subscription_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_subscription_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.quote_subscription_terms
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.quote_subscription_terms IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.quote_subscription_terms IS
  'Subscription terms priced on a quote line: plan (and lifecycle version), term length, start rule, billing timing, and co-term target. Deleted with the quote; plans and subscriptions are restrict-guarded.';

-- One priced period of a term's ramp: the unit price and quantity that apply
-- from starts_after_months into the term. An escalator percent prices the
-- NEXT period from this one; the engine resolves the full schedule
-- deterministically to minor units. Period 0 starts the term.
CREATE TABLE public.quote_ramp_steps (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  term_id uuid NOT NULL,
  period_index integer NOT NULL,
  starts_after_months integer NOT NULL,
  unit_price numeric(19,4) NOT NULL,
  quantity numeric(19,4) NOT NULL,
  escalator_percent numeric(9,4),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT quote_ramp_steps_pkey PRIMARY KEY (id),
  CONSTRAINT quote_ramp_steps_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT quote_ramp_steps_period_unique UNIQUE (org_id, term_id, period_index),
  CONSTRAINT quote_ramp_steps_period_valid
    CHECK (period_index >= 0 AND starts_after_months >= 0),
  CONSTRAINT quote_ramp_steps_price_valid
    CHECK (unit_price >= 0 AND quantity > 0),
  CONSTRAINT quote_ramp_steps_escalator_valid
    CHECK (escalator_percent IS NULL OR (escalator_percent >= -100 AND escalator_percent <= 100)),
  CONSTRAINT quote_ramp_steps_term_fk
    FOREIGN KEY (org_id, term_id) REFERENCES public.quote_subscription_terms(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT quote_ramp_steps_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

ALTER TABLE public.quote_ramp_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_ramp_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.quote_ramp_steps
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.quote_ramp_steps IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.quote_ramp_steps IS
  'Priced periods of a quote term ramp: unit price and quantity per period with an optional escalator into the next period.';

-- Quote-to-cash policy, one row per organization, edited in Setup. Absent
-- rows read as the working defaults, so the surface needs zero setup: the
-- discount threshold gates signature sends, auto-activate signs into billing
-- immediately, and the order-form template selects the PDF template the
-- signing presentation renders with (null keeps the quote default).
CREATE TABLE public.quote_to_cash_settings (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  max_discount_percent numeric(9,4) DEFAULT '10' NOT NULL,
  auto_activate_on_sign boolean DEFAULT false NOT NULL,
  default_billing_timing text DEFAULT 'advance' NOT NULL,
  default_start_rule text DEFAULT 'quote_date' NOT NULL,
  signature_expiry_days integer DEFAULT 14 NOT NULL,
  order_form_template_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT quote_to_cash_settings_pkey PRIMARY KEY (id),
  CONSTRAINT quote_to_cash_settings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT quote_to_cash_settings_org_unique UNIQUE (org_id),
  CONSTRAINT quote_to_cash_settings_discount_valid
    CHECK (max_discount_percent >= 0 AND max_discount_percent <= 100),
  CONSTRAINT quote_to_cash_settings_start_rule_valid
    CHECK (default_start_rule IN ('quote_date', 'first_of_next_month', 'custom')),
  CONSTRAINT quote_to_cash_settings_timing_valid
    CHECK (default_billing_timing IN ('advance', 'arrears')),
  CONSTRAINT quote_to_cash_settings_expiry_valid
    CHECK (signature_expiry_days >= 1 AND signature_expiry_days <= 90),
  CONSTRAINT quote_to_cash_settings_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

ALTER TABLE public.quote_to_cash_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_to_cash_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.quote_to_cash_settings
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.quote_to_cash_settings IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.quote_to_cash_settings IS
  'Quote-to-cash policy per organization: discount approval threshold, auto-activation, term defaults, signing-link expiry, and the order-form PDF template.';

-- E-signature requests over any subject row (quotes today; other subjects
-- later without a new store). The signer holds a possession token by email;
-- storage keeps only the token hash. document_hash is the SHA-256 of the
-- exact presentation hashed at send time, so signing after a subject edit
-- refuses instead of signing stale terms. At most one open request per
-- subject: editing a sent subject voids its request and requires re-sending.
CREATE TABLE public.signature_requests (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subject_table text NOT NULL,
  subject_id uuid NOT NULL,
  signer_name text NOT NULL,
  signer_email text NOT NULL,
  token_hash text NOT NULL,
  status text DEFAULT 'sent' NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  sent_at timestamp with time zone DEFAULT now() NOT NULL,
  viewed_at timestamp with time zone,
  signed_at timestamp with time zone,
  declined_at timestamp with time zone,
  voided_at timestamp with time zone,
  signer_ip text,
  signer_user_agent text,
  signature_svg text,
  document_hash text NOT NULL,
  consent_text text,
  signed_file_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT signature_requests_pkey PRIMARY KEY (id),
  CONSTRAINT signature_requests_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT signature_requests_token_unique UNIQUE (org_id, token_hash),
  CONSTRAINT signature_requests_subject_valid
    CHECK (length(btrim(subject_table)) > 0),
  CONSTRAINT signature_requests_signer_valid
    CHECK (length(btrim(signer_name)) > 0 AND length(btrim(signer_email)) > 0),
  CONSTRAINT signature_requests_status_valid
    CHECK (status IN ('sent', 'viewed', 'signed', 'declined', 'expired', 'voided')),
  CONSTRAINT signature_requests_lifecycle_valid
    CHECK ((status <> 'signed' OR signed_at IS NOT NULL)
       AND (status <> 'declined' OR declined_at IS NOT NULL)
       AND (status <> 'voided' OR voided_at IS NOT NULL)),
  CONSTRAINT signature_requests_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

-- One open request per subject: a second send while one is open is a caller
-- error, not a second row. Terminal states stay readable for the audit trail.
CREATE UNIQUE INDEX signature_requests_open_subject_unique
  ON public.signature_requests (org_id, subject_table, subject_id)
  WHERE status IN ('sent', 'viewed');

ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.signature_requests
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.signature_requests IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.signature_requests IS
  'Generic e-signature requests: one open request per subject row, possession-token hashes only, and the hash of the exact presentation signed. signed_file_id points at the signed PDF in files once the signing page stores it.';

-- The quote a subscription was activated from. The partial uniqueness is the
-- exactly-once authority: a signed quote activates one subscription, and a
-- second activation attempt for the same quote finds this row instead of
-- writing a second subscription. document_links cannot carry the edge: both
-- of its endpoints must be documents, and a subscription is not one.
ALTER TABLE public.subscriptions ADD COLUMN source_quote_id uuid;
ALTER TABLE public.subscriptions ADD COLUMN source_term_id uuid;

ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_source_quote_fk
  FOREIGN KEY (org_id, source_quote_id) REFERENCES public.documents(org_id, id) ON DELETE RESTRICT DEFERRABLE;

ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_source_term_fk
  FOREIGN KEY (org_id, source_term_id) REFERENCES public.quote_subscription_terms(org_id, id) ON DELETE RESTRICT DEFERRABLE;

-- Exactly-once authority for quote activation: one subscription per quote
-- line term. A twin activation converges on the existing row instead of
-- writing a second subscription.
CREATE UNIQUE INDEX subscriptions_source_term_unique
  ON public.subscriptions (org_id, source_quote_id, source_term_id) WHERE source_quote_id IS NOT NULL;

COMMENT ON COLUMN public.subscriptions.source_quote_id IS
  'Quote activated into this subscription. Part of the exactly-once authority for quote activation.';
COMMENT ON COLUMN public.subscriptions.source_term_id IS
  'Quote term activated into this subscription. Part of the exactly-once authority for quote activation.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('quote_to_cash_settings', '0506_quote_to_cash')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('quote_subscription_terms', '0506_quote_to_cash')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('quote_ramp_steps', '0506_quote_to_cash')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('signature_requests', '0506_quote_to_cash')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
