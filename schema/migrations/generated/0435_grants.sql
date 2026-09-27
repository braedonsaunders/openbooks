-- OpenBooks forward migration 0435_grants.
-- Grant agreements keep each amendment as a separately identifiable version;
-- drawdowns and reporting deadlines retain their own tenant-scoped evidence.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The primary key is globally unique, but this composite key lets grant rows
-- prove that an allowable-cost group belongs to the same organization.
CREATE UNIQUE INDEX account_groups_org_id_id_unique
  ON public.account_groups (org_id, id);

CREATE TABLE public.grants (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  sponsor_party_id uuid NOT NULL,
  sponsor_kind text NOT NULL,
  determination text NOT NULL,
  barrier text,
  barrier_met_at timestamp with time zone,
  barrier_evidence text,
  right_of_return boolean NOT NULL DEFAULT false,
  award_amount numeric(19,4) NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  indirect_rate numeric(20,10) NOT NULL DEFAULT 0,
  indirect_base text NOT NULL DEFAULT 'direct_costs',
  cost_share_required boolean NOT NULL DEFAULT false,
  cost_share_amount numeric(19,4) NOT NULL DEFAULT 0,
  fund_id uuid NOT NULL,
  allowable_account_group_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  award_entry_id uuid,
  version integer NOT NULL DEFAULT 1,
  supersedes_id uuid,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT grants_pkey PRIMARY KEY (id),
  CONSTRAINT grants_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT grants_sponsor_party_fkey
    FOREIGN KEY (org_id, sponsor_party_id) REFERENCES public.parties (org_id, id),
  CONSTRAINT grants_fund_fkey
    FOREIGN KEY (org_id, fund_id) REFERENCES public.funds (org_id, id),
  CONSTRAINT grants_allowable_account_group_fkey
    FOREIGN KEY (org_id, allowable_account_group_id) REFERENCES public.account_groups (org_id, id),
  CONSTRAINT grants_award_entry_fkey
    FOREIGN KEY (org_id, award_entry_id) REFERENCES public.journal_entries (org_id, id),
  CONSTRAINT grants_supersedes_fkey
    FOREIGN KEY (org_id, supersedes_id) REFERENCES public.grants (org_id, id),
  CONSTRAINT grants_sponsor_kind_check
    CHECK (sponsor_kind IN ('government', 'foundation', 'corporate')),
  CONSTRAINT grants_determination_check
    CHECK (determination IN ('contribution_unconditional', 'contribution_conditional', 'exchange')),
  CONSTRAINT grants_conditional_terms_check
    CHECK (determination <> 'contribution_conditional'
      OR (length(btrim(coalesce(barrier, ''))) > 0 AND right_of_return)),
  CONSTRAINT grants_barrier_evidence_pair_check
    CHECK ((barrier_met_at IS NULL) = (barrier_evidence IS NULL)
      AND (barrier_evidence IS NULL OR length(btrim(barrier_evidence)) > 0)),
  CONSTRAINT grants_amount_check CHECK (award_amount > 0),
  CONSTRAINT grants_period_check CHECK (period_to >= period_from),
  CONSTRAINT grants_indirect_rate_check CHECK (indirect_rate >= 0),
  CONSTRAINT grants_indirect_base_check
    CHECK (indirect_base IN ('direct_costs', 'modified_total_direct')),
  CONSTRAINT grants_cost_share_check
    CHECK (cost_share_amount >= 0 AND (cost_share_required OR cost_share_amount = 0)),
  CONSTRAINT grants_status_check
    CHECK (status IN ('draft', 'awarded', 'active', 'closed_out', 'closed', 'void')),
  CONSTRAINT grants_version_check
    CHECK ((version = 1 AND supersedes_id IS NULL) OR (version > 1 AND supersedes_id IS NOT NULL)),
  CONSTRAINT grants_not_self_superseded_check CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT grants_org_code_version_unique UNIQUE (org_id, code, version)
);

CREATE UNIQUE INDEX grants_org_successor_unique
  ON public.grants (org_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL;
CREATE INDEX grants_org_status ON public.grants (org_id, status, code);
CREATE INDEX grants_org_fund ON public.grants (org_id, fund_id);
CREATE INDEX grants_org_sponsor ON public.grants (org_id, sponsor_party_id);
CREATE INDEX grants_org_allowable_group ON public.grants (org_id, allowable_account_group_id);

ALTER TABLE public.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.grants
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY tenant_isolation ON public.grants IS 'openbooks:org_isolation:v1';

CREATE TABLE public.grant_reports (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  title text NOT NULL,
  due_on date NOT NULL,
  submitted_at timestamp with time zone,
  submitted_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT grant_reports_pkey PRIMARY KEY (id),
  CONSTRAINT grant_reports_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT grant_reports_grant_fkey
    FOREIGN KEY (org_id, grant_id) REFERENCES public.grants (org_id, id),
  CONSTRAINT grant_reports_title_check CHECK (length(btrim(title)) > 0)
);
CREATE INDEX grant_reports_org_grant_due ON public.grant_reports (org_id, grant_id, due_on, id);

ALTER TABLE public.grant_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grant_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.grant_reports
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY tenant_isolation ON public.grant_reports IS 'openbooks:org_isolation:v1';

CREATE TABLE public.grant_drawdowns (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  receivable_entry_id uuid,
  revenue_entry_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT grant_drawdowns_pkey PRIMARY KEY (id),
  CONSTRAINT grant_drawdowns_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT grant_drawdowns_grant_fkey
    FOREIGN KEY (org_id, grant_id) REFERENCES public.grants (org_id, id),
  CONSTRAINT grant_drawdowns_receivable_entry_fkey
    FOREIGN KEY (org_id, receivable_entry_id) REFERENCES public.journal_entries (org_id, id),
  CONSTRAINT grant_drawdowns_revenue_entry_fkey
    FOREIGN KEY (org_id, revenue_entry_id) REFERENCES public.journal_entries (org_id, id),
  CONSTRAINT grant_drawdowns_amount_check CHECK (amount > 0),
  CONSTRAINT grant_drawdowns_kind_check CHECK (kind IN ('advance', 'reimbursement', 'final')),
  CONSTRAINT grant_drawdowns_status_check CHECK (status IN ('draft', 'submitted', 'paid', 'recognized', 'void'))
);
CREATE INDEX grant_drawdowns_org_grant_status
  ON public.grant_drawdowns (org_id, grant_id, status, id);

ALTER TABLE public.grant_drawdowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grant_drawdowns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.grant_drawdowns
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY tenant_isolation ON public.grant_drawdowns IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('grants', '0435'), ('grant_reports', '0435'), ('grant_drawdowns', '0435')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
