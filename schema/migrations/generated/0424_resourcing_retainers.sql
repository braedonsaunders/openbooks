-- OpenBooks forward migration 0424_resourcing_retainers.
-- Store retainer terms and their weekly revenue-recognition drawdown evidence.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.res_retainers (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  customer_party_id uuid NOT NULL,
  kind text NOT NULL,
  total_amount numeric(19,4) NOT NULL,
  total_hours numeric(19,4),
  unit_rate numeric(19,4),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  retainer_item_id uuid NOT NULL,
  invoice_document_id uuid,
  obligation_id uuid,
  state text DEFAULT 'draft' NOT NULL,
  custom jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT res_retainers_pkey PRIMARY KEY (id),
  CONSTRAINT res_retainers_kind CHECK (kind IN ('hours', 'fees')),
  CONSTRAINT res_retainers_total_amount_positive CHECK (total_amount > 0),
  CONSTRAINT res_retainers_hours_terms CHECK (
    (kind = 'hours' AND total_hours IS NOT NULL AND unit_rate IS NOT NULL)
    OR (kind = 'fees' AND total_hours IS NULL AND unit_rate IS NULL)
  ),
  CONSTRAINT res_retainers_date_order CHECK (starts_on <= ends_on),
  CONSTRAINT res_retainers_state CHECK (state IN ('draft', 'active', 'exhausted', 'expired', 'closed')),
  CONSTRAINT res_retainers_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT res_retainers_project_tenant_fkey
    FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_retainers_customer_party_tenant_fkey
    FOREIGN KEY (org_id, customer_party_id) REFERENCES public.parties(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_retainers_item_tenant_fkey
    FOREIGN KEY (org_id, retainer_item_id) REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_retainers_invoice_document_tenant_fkey
    FOREIGN KEY (org_id, invoice_document_id) REFERENCES public.documents(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_retainers_obligation_tenant_fkey
    FOREIGN KEY (org_id, obligation_id) REFERENCES public.performance_obligations(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_retainers_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT res_retainers_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

CREATE UNIQUE INDEX res_retainers_org_id_id_unique ON public.res_retainers (org_id, id);
CREATE INDEX res_retainers_project ON public.res_retainers (org_id, project_id);

CREATE TABLE public.res_retainer_drawdowns (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  retainer_id uuid NOT NULL,
  week_start date NOT NULL,
  hours numeric(19,4) NOT NULL,
  amount numeric(19,4) NOT NULL,
  state text DEFAULT 'draft' NOT NULL,
  recognition_event_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT res_retainer_drawdowns_pkey PRIMARY KEY (id),
  CONSTRAINT res_retainer_drawdowns_week_start_sunday CHECK (extract(dow from week_start) = 0),
  CONSTRAINT res_retainer_drawdowns_hours_nonnegative CHECK (hours >= 0),
  CONSTRAINT res_retainer_drawdowns_amount_positive CHECK (amount > 0),
  CONSTRAINT res_retainer_drawdowns_state CHECK (state IN ('draft', 'posted')),
  CONSTRAINT res_retainer_drawdowns_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT res_retainer_drawdowns_retainer_tenant_fkey
    FOREIGN KEY (org_id, retainer_id) REFERENCES public.res_retainers(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_retainer_drawdowns_recognition_event_id_fkey
    FOREIGN KEY (recognition_event_id) REFERENCES public.recognition_events(id) DEFERRABLE,
  CONSTRAINT res_retainer_drawdowns_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT res_retainer_drawdowns_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

CREATE UNIQUE INDEX res_retainer_drawdowns_org_id_id_unique ON public.res_retainer_drawdowns (org_id, id);
CREATE UNIQUE INDEX res_retainer_drawdowns_retainer_week
  ON public.res_retainer_drawdowns (org_id, retainer_id, week_start);

CREATE TABLE public.res_retainer_drawdown_entries (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  drawdown_id uuid NOT NULL,
  time_entry_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT res_retainer_drawdown_entries_pkey PRIMARY KEY (id),
  CONSTRAINT res_retainer_drawdown_entries_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT res_retainer_drawdown_entries_drawdown_tenant_fkey
    FOREIGN KEY (org_id, drawdown_id) REFERENCES public.res_retainer_drawdowns(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT res_retainer_drawdown_entries_time_entry_tenant_fkey
    FOREIGN KEY (org_id, time_entry_id) REFERENCES public.time_entries(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_retainer_drawdown_entries_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT res_retainer_drawdown_entries_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

CREATE UNIQUE INDEX res_retainer_drawdown_entries_org_id_id_unique
  ON public.res_retainer_drawdown_entries (org_id, id);
CREATE UNIQUE INDEX res_retainer_drawdown_entries_time_entry
  ON public.res_retainer_drawdown_entries (org_id, time_entry_id);

ALTER TABLE public.res_retainers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.res_retainers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.res_retainers
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.res_retainers IS 'openbooks:org_isolation:v1';

ALTER TABLE public.res_retainer_drawdowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.res_retainer_drawdowns FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.res_retainer_drawdowns
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.res_retainer_drawdowns IS 'openbooks:org_isolation:v1';

ALTER TABLE public.res_retainer_drawdown_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.res_retainer_drawdown_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.res_retainer_drawdown_entries
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.res_retainer_drawdown_entries IS 'openbooks:org_isolation:v1';

-- Replays may encounter an existing relation registration; the row is intentionally left intact.
INSERT INTO openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('res_retainer_drawdown_entries', '0424'),
  ('res_retainer_drawdowns', '0424'),
  ('res_retainers', '0424')
ON CONFLICT (relation) DO NOTHING;
SELECT public.openbooks_refresh_query_catalog();
