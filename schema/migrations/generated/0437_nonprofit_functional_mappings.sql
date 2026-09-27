-- OpenBooks forward migration 0437_nonprofit_functional_mappings.
-- Effective-dated department and project mappings preserve historical function reporting.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE public.functional_mappings (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  department_id uuid,
  project_id uuid,
  function text NOT NULL,
  program_key text,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  CONSTRAINT functional_mappings_pkey PRIMARY KEY (id),
  CONSTRAINT functional_mappings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT functional_mappings_org_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs (id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT functional_mappings_department_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT functional_mappings_project_fkey
    FOREIGN KEY (org_id, project_id) REFERENCES public.projects (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT functional_mappings_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users (id) DEFERRABLE,
  CONSTRAINT functional_mappings_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users (id) DEFERRABLE,
  CONSTRAINT functional_mappings_one_subject_check
    CHECK ((department_id IS NOT NULL) <> (project_id IS NOT NULL)),
  CONSTRAINT functional_mappings_function_check
    CHECK (function IN ('program', 'management_general', 'fundraising')),
  CONSTRAINT functional_mappings_program_key_check
    CHECK (function = 'program' OR program_key IS NULL),
  CONSTRAINT functional_mappings_effective_dates_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT functional_mappings_department_period_excl
    EXCLUDE USING gist (
      org_id WITH =,
      department_id WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    ) WHERE (department_id IS NOT NULL),
  CONSTRAINT functional_mappings_project_period_excl
    EXCLUDE USING gist (
      org_id WITH =,
      project_id WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    ) WHERE (project_id IS NOT NULL)
);

CREATE INDEX functional_mappings_org_department_effective
  ON public.functional_mappings (org_id, department_id, effective_from DESC)
  WHERE department_id IS NOT NULL;
CREATE INDEX functional_mappings_org_project_effective
  ON public.functional_mappings (org_id, project_id, effective_from DESC)
  WHERE project_id IS NOT NULL;

ALTER TABLE public.functional_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.functional_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.functional_mappings
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY tenant_isolation ON public.functional_mappings IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('functional_mappings', '0437_nonprofit_functional_mappings')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
select openbooks_refresh_query_catalog();
