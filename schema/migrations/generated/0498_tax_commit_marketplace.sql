-- OpenBooks forward migration 0498_tax_commit_marketplace.
-- Commit posted sales tax to the configured rate provider (Avalara/TaxJar)
-- and record marketplace-facilitator collection separately from the
-- merchant's own liability. New tables start empty; the two altered tables
-- gain defaulted columns whose CHECK constraints every existing row satisfies.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- One commit/void tracking row per posted sales document, provider and
-- direction. The posting transaction enqueues the row; the periodic
-- tax_provider_commit scan performs the provider call with retries.
CREATE TABLE public.tax_provider_transactions (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  provider text NOT NULL,
  provider_code text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  void_requested_at timestamptz,
  committed_at timestamptz,
  provider_response_excerpt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT tax_provider_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT tax_provider_transactions_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT tax_provider_transactions_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT tax_provider_transactions_document_fk
    FOREIGN KEY (org_id, document_id) REFERENCES public.documents(org_id, id) ON DELETE CASCADE,
  CONSTRAINT tax_provider_transactions_provider_valid
    CHECK (provider IN ('avalara', 'taxjar', 'custom_http')),
  CONSTRAINT tax_provider_transactions_kind_valid
    CHECK (kind IN ('sale', 'return')),
  CONSTRAINT tax_provider_transactions_status_valid
    CHECK (status IN ('pending', 'committed', 'voided', 'failed', 'skipped')),
  CONSTRAINT tax_provider_transactions_code_nonblank
    CHECK (length(btrim(provider_code)) > 0),
  CONSTRAINT tax_provider_transactions_attempts_domain
    CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX tax_provider_transactions_document_unique
  ON public.tax_provider_transactions (document_id, provider, kind);
CREATE INDEX tax_provider_transactions_scan
  ON public.tax_provider_transactions (status, next_attempt_at);

ALTER TABLE public.tax_provider_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_provider_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.tax_provider_transactions
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.tax_provider_transactions IS 'openbooks:org_isolation:v1';

-- Marketplace facilitators whose collection the merchant reports but never
-- owes: tax they collect posts to the clearing account (settled through the
-- marketplace payout), never to the merchant's tax liability.
CREATE TABLE public.marketplace_facilitators (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  clearing_account_id uuid NOT NULL,
  collection_mode text NOT NULL DEFAULT 'gross',
  states text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT marketplace_facilitators_pkey PRIMARY KEY (id),
  CONSTRAINT marketplace_facilitators_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT marketplace_facilitators_org_name_unique UNIQUE (org_id, name),
  CONSTRAINT marketplace_facilitators_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT marketplace_facilitators_clearing_fk
    FOREIGN KEY (org_id, clearing_account_id) REFERENCES public.accounts(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT marketplace_facilitators_name_nonblank
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT marketplace_facilitators_mode_valid
    CHECK (collection_mode IN ('gross', 'net'))
);

ALTER TABLE public.marketplace_facilitators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_facilitators FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.marketplace_facilitators
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.marketplace_facilitators IS 'openbooks:org_isolation:v1';

-- Whether a state's economic-nexus threshold counts marketplace-facilitated
-- sales. Global reference data (like currencies): states with a verified rule
-- are seeded below with their source; a state with no row defaults to
-- INCLUDE and is reported as needing review, never silently guessed.
CREATE TABLE public.marketplace_nexus_state_rules (
  state text NOT NULL,
  include_in_threshold boolean NOT NULL DEFAULT true,
  needs_review boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT '',
  CONSTRAINT marketplace_nexus_state_rules_pkey PRIMARY KEY (state),
  CONSTRAINT marketplace_nexus_state_rules_state_valid
    CHECK (state ~ '^[A-Z]{2}$')
);
COMMENT ON TABLE public.marketplace_nexus_state_rules IS
  'Per-state marketplace-facilitator nexus treatment. Seeded only where the rule is cited; unlisted states default to included pending review.';

INSERT INTO public.marketplace_nexus_state_rules (state, include_in_threshold, needs_review, source) VALUES
  ('CA', true, false, 'CDTFA marketplace guidance: marketplace sales count toward the $500,000 economic nexus threshold'),
  ('FL', false, false, 'Florida SB 50 (2021): sales made through a marketplace provider do not count toward the $100,000 remote-seller threshold'),
  ('TX', true, false, 'Texas marketplace guidance: total Texas receipts including marketplace sales count toward the $500,000 threshold');

-- Tax the marketplace collects and remits: kept on the component for
-- reporting and nexus, posted to the facilitator clearing account instead of
-- the merchant liability.
ALTER TABLE public.document_line_tax_components
  ADD COLUMN collected_by text NOT NULL DEFAULT 'merchant';
ALTER TABLE public.document_line_tax_components
  ADD CONSTRAINT document_line_tax_components_collected_by_valid
    CHECK (collected_by IN ('merchant', 'marketplace'));
ALTER TABLE public.document_line_tax_components
  ADD COLUMN facilitator_name text;

-- The line-level source of the marketplace flag: recalculation rebuilds
-- component rows, so the toggle lives on the line and components inherit it.
ALTER TABLE public.document_lines
  ADD COLUMN marketplace_facilitator text;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('tax_provider_transactions', '0498_tax_commit_marketplace')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('marketplace_facilitators', '0498_tax_commit_marketplace')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
