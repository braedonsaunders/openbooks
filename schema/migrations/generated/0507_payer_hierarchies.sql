-- OpenBooks forward migration 0507_payer_hierarchies.
-- Payer hierarchies and consolidated billing: a customer hierarchy separates
-- the service-to party (who uses the subscription), the bill-to party (who
-- receives the invoice) and the payer (whose AR it is). Consolidation groups
-- collect a period's draft charges into one invoice per payer, including
-- across legal entities. Changing a relationship never reinterprets posted
-- history: relationships are effective-dated and resolution pins the parties
-- on the billing date.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Consolidation groups: one monthly (or weekly) invoice per payer. The
-- billing subsidiary is the legal entity that issues the consolidated
-- invoice; service lines booked elsewhere post intercompany legs through the
-- ledger kernel, which refuses by name when no intercompany pair exists.
CREATE TABLE public.consolidation_groups (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  payer_party_id uuid NOT NULL,
  billing_subsidiary_id uuid,
  cadence text NOT NULL DEFAULT 'monthly',
  cutoff_day integer NOT NULL DEFAULT 1,
  grouping text NOT NULL DEFAULT 'by_child',
  template text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT consolidation_groups_pkey PRIMARY KEY (id),
  CONSTRAINT consolidation_groups_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT consolidation_groups_org_code_unique UNIQUE (org_id, code),
  CONSTRAINT consolidation_groups_code_nonblank CHECK (length(btrim(code)) > 0),
  CONSTRAINT consolidation_groups_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT consolidation_groups_cadence_valid CHECK (cadence IN ('weekly', 'monthly')),
  CONSTRAINT consolidation_groups_cutoff_valid CHECK (cutoff_day BETWEEN 1 AND 28),
  CONSTRAINT consolidation_groups_grouping_valid CHECK (grouping IN ('by_child', 'by_subscription', 'by_product')),
  CONSTRAINT consolidation_groups_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT consolidation_groups_payer_org_fk
    FOREIGN KEY (org_id, payer_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT consolidation_groups_billing_subsidiary_org_fk
    FOREIGN KEY (org_id, billing_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE
);

CREATE INDEX consolidation_groups_org_payer ON public.consolidation_groups (org_id, payer_party_id);

ALTER TABLE public.consolidation_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.consolidation_groups
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.consolidation_groups IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.consolidation_groups IS
  'Consolidated billing groups: one invoice per payer per period. The payer owns the AR; the billing subsidiary issues the invoice; lines keep their service entity so cross-entity charges post intercompany legs.';

-- Customer billing relationships: who a service-to party bills through.
-- Effective-dated so a mid-year change bills each period to the right payer.
-- At least one of bill-to/payer must differ from the child: a row that
-- changes nothing is a misconfiguration, not a relationship.
CREATE TABLE public.customer_billing_relationships (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  child_party_id uuid NOT NULL,
  bill_to_party_id uuid NOT NULL,
  payer_party_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  consolidation_group_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT customer_billing_relationships_pkey PRIMARY KEY (id),
  CONSTRAINT customer_billing_relationships_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT customer_billing_relationships_window_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT customer_billing_relationships_redirects_somewhere
    CHECK (child_party_id <> bill_to_party_id OR child_party_id <> payer_party_id),
  CONSTRAINT customer_billing_relationships_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT customer_billing_relationships_child_org_fk
    FOREIGN KEY (org_id, child_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT customer_billing_relationships_bill_to_org_fk
    FOREIGN KEY (org_id, bill_to_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT customer_billing_relationships_payer_org_fk
    FOREIGN KEY (org_id, payer_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT customer_billing_relationships_group_org_fk
    FOREIGN KEY (org_id, consolidation_group_id) REFERENCES public.consolidation_groups(org_id, id) DEFERRABLE
);

CREATE INDEX customer_billing_relationships_child_window
  ON public.customer_billing_relationships (org_id, child_party_id, effective_from);

ALTER TABLE public.customer_billing_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_billing_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.customer_billing_relationships
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.customer_billing_relationships IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.customer_billing_relationships IS
  'Payer hierarchy edges: the service-to child party, the bill-to recipient and the AR payer, with the consolidation group the charge consolidates through. Overlapping windows for one child are refused by the write path; resolution reads the latest effective row.';

-- Consolidation runs: the idempotency guard. One row per (group, period,
-- currency, billing subsidiary); a re-run replays the committed invoice
-- instead of cutting a second one.
CREATE TABLE public.consolidation_runs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  group_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL,
  billing_subsidiary_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT consolidation_runs_pkey PRIMARY KEY (id),
  CONSTRAINT consolidation_runs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT consolidation_runs_one_invoice_per_bucket
    UNIQUE (org_id, group_id, period_start, period_end, currency, billing_subsidiary_id),
  CONSTRAINT consolidation_runs_period_valid CHECK (period_end >= period_start),
  CONSTRAINT consolidation_runs_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT consolidation_runs_group_org_fk
    FOREIGN KEY (org_id, group_id) REFERENCES public.consolidation_groups(org_id, id) DEFERRABLE,
  CONSTRAINT consolidation_runs_billing_subsidiary_org_fk
    FOREIGN KEY (org_id, billing_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT consolidation_runs_invoice_org_fk
    FOREIGN KEY (org_id, invoice_id) REFERENCES public.documents(org_id, id) DEFERRABLE
);

CREATE INDEX consolidation_runs_group_period
  ON public.consolidation_runs (org_id, group_id, period_start, period_end);

ALTER TABLE public.consolidation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.consolidation_runs
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.consolidation_runs IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.consolidation_runs IS
  'Consolidation run guard: exactly one invoice per group, period, currency and billing entity. Re-running a completed bucket replays the invoice.';

-- Subscription-level bill-to/payer overrides. Null means the hierarchy
-- relationship (or self-billing) applies.
ALTER TABLE public.subscriptions
  ADD COLUMN bill_to_party_id uuid,
  ADD COLUMN payer_party_id uuid;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_bill_to_org_fk
    FOREIGN KEY (org_id, bill_to_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  ADD CONSTRAINT subscriptions_payer_org_fk
    FOREIGN KEY (org_id, payer_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE;

-- The service-to party for one invoice line: the child the line is for.
-- Informational grouping only — the AR leg follows the header party, never
-- this column. (Distinct from document_lines.party_id, the line-level
-- subledger entity that carries AR/AP legs on journal-style lines.)
ALTER TABLE public.document_lines
  ADD COLUMN service_party_id uuid;
ALTER TABLE public.document_lines
  ADD CONSTRAINT document_lines_service_party_org_fk
    FOREIGN KEY (org_id, service_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE;

CREATE INDEX document_lines_service_party
  ON public.document_lines (org_id, service_party_id);

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('consolidation_groups', '0507_payer_hierarchies')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('customer_billing_relationships', '0507_payer_hierarchies')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('consolidation_runs', '0507_payer_hierarchies')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
