-- OpenBooks forward migration 0436_nonprofit_encumbrances.
-- Budget commitments and budget cells retain the dimensions used by posting control.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.budget_lines
  ADD COLUMN extra_dims jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ONLY public.budget_lines
  DROP CONSTRAINT budget_lines_cell;

ALTER TABLE ONLY public.budget_lines
  ADD CONSTRAINT budget_lines_cell
  UNIQUE NULLS NOT DISTINCT
    (scenario_id, account_id, period_id, subsidiary_id,
     department_id, project_id, location_id, class_id, extra_dims);

CREATE TRIGGER budget_lines_extra_dims_guard
  BEFORE INSERT OR UPDATE OF org_id, extra_dims, subsidiary_id
  ON public.budget_lines
  FOR EACH ROW EXECUTE FUNCTION public.row_extra_dims_guard();

CREATE TABLE public.encumbrances (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  encumbrance_number text NOT NULL,
  source_kind text NOT NULL,
  source_id uuid,
  account_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  department_id uuid,
  project_id uuid,
  location_id uuid,
  class_id uuid,
  extra_dims jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount numeric(19,4) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT encumbrances_pkey PRIMARY KEY (id),
  CONSTRAINT encumbrances_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT encumbrances_org_number_unique UNIQUE (org_id, encumbrance_number),
  CONSTRAINT encumbrances_source_kind_check
    CHECK (source_kind IN ('purchase_order', 'manual')),
  CONSTRAINT encumbrances_source_check
    CHECK (source_kind <> 'purchase_order' OR source_id IS NOT NULL),
  CONSTRAINT encumbrances_amount_check CHECK (amount > 0),
  CONSTRAINT encumbrances_status_check CHECK (status IN ('open', 'closed', 'void')),
  CONSTRAINT encumbrances_org_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs (id) DEFERRABLE,
  CONSTRAINT encumbrances_account_fkey
    FOREIGN KEY (org_id, account_id) REFERENCES public.accounts (org_id, id) DEFERRABLE,
  CONSTRAINT encumbrances_subsidiary_fkey
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries (org_id, id) DEFERRABLE,
  CONSTRAINT encumbrances_department_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments (org_id, id) DEFERRABLE,
  CONSTRAINT encumbrances_project_fkey
    FOREIGN KEY (org_id, project_id) REFERENCES public.projects (org_id, id) DEFERRABLE,
  CONSTRAINT encumbrances_location_fkey
    FOREIGN KEY (org_id, location_id) REFERENCES public.locations (org_id, id) DEFERRABLE,
  CONSTRAINT encumbrances_class_fkey
    FOREIGN KEY (org_id, class_id) REFERENCES public.classes (org_id, id) DEFERRABLE,
  CONSTRAINT encumbrances_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users (id) DEFERRABLE,
  CONSTRAINT encumbrances_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users (id) DEFERRABLE
);

ALTER TABLE public.encumbrances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encumbrances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.encumbrances
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE INDEX encumbrances_org_status
  ON public.encumbrances (org_id, status);

CREATE TRIGGER encumbrances_extra_dims_guard
  BEFORE INSERT OR UPDATE OF org_id, extra_dims, subsidiary_id
  ON public.encumbrances
  FOR EACH ROW EXECUTE FUNCTION public.row_extra_dims_guard();

CREATE TABLE public.encumbrance_links (
  org_id uuid NOT NULL,
  encumbrance_id uuid NOT NULL,
  document_line_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT encumbrance_links_pkey
    PRIMARY KEY (org_id, encumbrance_id, document_line_id),
  CONSTRAINT encumbrance_links_one_per_line
    UNIQUE (org_id, document_line_id),
  CONSTRAINT encumbrance_links_encumbrance_fkey
    FOREIGN KEY (org_id, encumbrance_id)
    REFERENCES public.encumbrances (org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT encumbrance_links_document_line_fkey
    FOREIGN KEY (org_id, document_line_id)
    REFERENCES public.document_lines (org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT encumbrance_links_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users (id) DEFERRABLE
);

ALTER TABLE public.encumbrance_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encumbrance_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.encumbrance_links
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE INDEX encumbrance_links_org_encumbrance
  ON public.encumbrance_links (org_id, encumbrance_id);

-- The registry owns one row per relation, so a replay keeps its existing row.
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('encumbrances', '0436'),
  ('encumbrance_links', '0436')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
