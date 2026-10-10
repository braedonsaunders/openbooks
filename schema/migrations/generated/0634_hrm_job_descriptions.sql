-- OpenBooks forward migration 0634_hrm_job_descriptions.
-- Reusable job descriptions: the organization's library of posting content
-- (title, employment kind, pay range, description) that a new requisition
-- starts from. A requisition copies the content when it is created, so later
-- library edits never rewrite a live or historical opening; job_description_id
-- records which library entry it started from. Entries referenced by a
-- requisition are history-pinned: deactivate them instead of deleting them.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.hrm_job_descriptions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    title text NOT NULL,
    employment_kind text,
    compensation_min numeric,
    compensation_max numeric,
    compensation_currency text,
    compensation_basis text,
    description text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_job_descriptions_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_job_descriptions_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT hrm_job_descriptions_org_name UNIQUE (org_id, name),
    CONSTRAINT hrm_job_descriptions_name_not_blank CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_job_descriptions_title_not_blank CHECK (char_length(btrim(title)) > 0),
    CONSTRAINT hrm_job_descriptions_description_not_blank CHECK (char_length(btrim(description)) > 0),
    CONSTRAINT hrm_job_descriptions_employment_kind_not_blank
      CHECK (employment_kind IS NULL OR char_length(btrim(employment_kind)) > 0),
    -- The pay range is all-or-nothing, non-negative and ordered, matching
    -- the requisition's compensation contract it is copied into.
    CONSTRAINT hrm_job_descriptions_compensation_complete CHECK (
      (compensation_min IS NULL AND compensation_max IS NULL
        AND compensation_currency IS NULL AND compensation_basis IS NULL)
      OR (compensation_min IS NOT NULL AND compensation_max IS NOT NULL
        AND compensation_currency IS NOT NULL AND compensation_basis IS NOT NULL)),
    CONSTRAINT hrm_job_descriptions_compensation_range CHECK (
      compensation_min IS NULL OR (compensation_min >= 0 AND compensation_min <= compensation_max)),
    CONSTRAINT hrm_job_descriptions_compensation_currency CHECK (
      compensation_currency IS NULL OR compensation_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT hrm_job_descriptions_compensation_basis CHECK (
      compensation_basis IS NULL OR compensation_basis IN ('hourly', 'annual')),
    CONSTRAINT hrm_job_descriptions_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT hrm_job_descriptions_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
    CONSTRAINT hrm_job_descriptions_updated_by_fkey FOREIGN KEY (updated_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE
);

COMMENT ON TABLE public.hrm_job_descriptions IS
  'HRM job descriptions (0634): reusable posting content a requisition starts from. Requisitions copy the content at creation; an entry referenced by a requisition is history-pinned, so deactivate it instead of deleting it.';

ALTER TABLE public.hrm_requisitions ADD COLUMN job_description_id uuid;

ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_job_description_tenant_fkey
  FOREIGN KEY (org_id, job_description_id) REFERENCES public.hrm_job_descriptions(org_id, id)
  ON DELETE RESTRICT DEFERRABLE;

CREATE INDEX hrm_requisitions_job_description
  ON public.hrm_requisitions (org_id, job_description_id)
  WHERE job_description_id IS NOT NULL;

ALTER TABLE ONLY public.hrm_job_descriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.hrm_job_descriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_job_descriptions
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.hrm_job_descriptions IS 'openbooks:org_isolation:v1';
