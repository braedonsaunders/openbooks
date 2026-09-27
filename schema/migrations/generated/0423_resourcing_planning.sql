-- OpenBooks forward migration 0423_resourcing_planning.
-- Store tenant-scoped assignments, resource requests and manual demand.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.res_requests (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  employee_party_id uuid,
  job_title text,
  first_week date NOT NULL,
  last_week date NOT NULL,
  hours_per_week numeric(19,4) NOT NULL,
  is_billable boolean DEFAULT true NOT NULL,
  bill_item_id uuid,
  reason text,
  status text DEFAULT 'draft' NOT NULL,
  decided_by uuid,
  decided_at timestamp with time zone,
  decision_comment text,
  flow_instance_id uuid,
  custom jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT res_requests_pkey PRIMARY KEY (id),
  CONSTRAINT res_requests_subject CHECK (num_nonnulls(employee_party_id, job_title) = 1),
  CONSTRAINT res_requests_job_title_nonblank CHECK (job_title IS NULL OR length(btrim(job_title)) > 0),
  CONSTRAINT res_requests_first_week_sunday CHECK (extract(dow from first_week) = 0),
  CONSTRAINT res_requests_last_week_sunday CHECK (extract(dow from last_week) = 0),
  CONSTRAINT res_requests_week_order CHECK (first_week <= last_week),
  CONSTRAINT res_requests_hours_per_week_range CHECK (hours_per_week > 0 AND hours_per_week <= 168),
  CONSTRAINT res_requests_status CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT res_requests_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT res_requests_project_tenant_fkey
    FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_requests_employee_party_tenant_fkey
    FOREIGN KEY (org_id, employee_party_id) REFERENCES public.parties(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_requests_bill_item_tenant_fkey
    FOREIGN KEY (org_id, bill_item_id) REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_requests_decided_by_fk
    FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT res_requests_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT res_requests_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

CREATE UNIQUE INDEX res_requests_org_id_id_unique ON public.res_requests (org_id, id);
CREATE INDEX res_requests_status ON public.res_requests (org_id, status);

CREATE TABLE public.res_assignments (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  employee_party_id uuid,
  job_title text,
  week_start date NOT NULL,
  planned_hours numeric(19,4) NOT NULL,
  is_billable boolean DEFAULT true NOT NULL,
  bill_item_id uuid,
  project_task_id uuid,
  booking text DEFAULT 'hard' NOT NULL,
  state text DEFAULT 'active' NOT NULL,
  source text DEFAULT 'manual' NOT NULL,
  request_id uuid,
  custom jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT res_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT res_assignments_subject CHECK (num_nonnulls(employee_party_id, job_title) = 1),
  CONSTRAINT res_assignments_job_title_nonblank CHECK (job_title IS NULL OR length(btrim(job_title)) > 0),
  CONSTRAINT res_assignments_week_start_sunday CHECK (extract(dow from week_start) = 0),
  CONSTRAINT res_assignments_planned_hours_range CHECK (planned_hours > 0 AND planned_hours <= 168),
  CONSTRAINT res_assignments_booking CHECK (booking IN ('soft', 'hard')),
  CONSTRAINT res_assignments_state CHECK (state IN ('active', 'released')),
  CONSTRAINT res_assignments_source CHECK (source IN ('manual', 'request', 'pipeline')),
  CONSTRAINT res_assignments_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT res_assignments_project_tenant_fkey
    FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_assignments_employee_party_tenant_fkey
    FOREIGN KEY (org_id, employee_party_id) REFERENCES public.parties(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_assignments_bill_item_tenant_fkey
    FOREIGN KEY (org_id, bill_item_id) REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_assignments_project_task_id_fkey
    FOREIGN KEY (project_task_id) REFERENCES public.project_tasks(id) DEFERRABLE,
  CONSTRAINT res_assignments_request_tenant_fkey
    FOREIGN KEY (org_id, request_id) REFERENCES public.res_requests(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_assignments_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT res_assignments_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

CREATE UNIQUE INDEX res_assignments_org_id_id_unique ON public.res_assignments (org_id, id);
CREATE UNIQUE INDEX res_assignments_booking_key
  ON public.res_assignments
    (org_id, project_id, week_start, coalesce(employee_party_id::text, lower(job_title)));
CREATE INDEX res_assignments_employee_week ON public.res_assignments (org_id, employee_party_id, week_start);
CREATE INDEX res_assignments_week ON public.res_assignments (org_id, week_start);

CREATE TABLE public.res_demand_lines (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  department_id uuid NOT NULL,
  job_title text NOT NULL,
  first_week date NOT NULL,
  last_week date NOT NULL,
  hours_per_week numeric(19,4) NOT NULL,
  note text,
  opportunity_id uuid,
  custom jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT res_demand_lines_pkey PRIMARY KEY (id),
  CONSTRAINT res_demand_lines_job_title_nonblank CHECK (length(btrim(job_title)) > 0),
  CONSTRAINT res_demand_lines_first_week_sunday CHECK (extract(dow from first_week) = 0),
  CONSTRAINT res_demand_lines_last_week_sunday CHECK (extract(dow from last_week) = 0),
  CONSTRAINT res_demand_lines_week_order CHECK (first_week <= last_week),
  CONSTRAINT res_demand_lines_hours_per_week_range CHECK (hours_per_week > 0 AND hours_per_week <= 168),
  CONSTRAINT res_demand_lines_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT res_demand_lines_department_tenant_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT res_demand_lines_opportunity_id_fkey
    FOREIGN KEY (opportunity_id) REFERENCES public.crm_opportunities(id) DEFERRABLE,
  CONSTRAINT res_demand_lines_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT res_demand_lines_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

CREATE UNIQUE INDEX res_demand_lines_org_id_id_unique ON public.res_demand_lines (org_id, id);

ALTER TABLE public.res_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.res_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.res_requests
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.res_requests IS 'openbooks:org_isolation:v1';

ALTER TABLE public.res_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.res_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.res_assignments
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.res_assignments IS 'openbooks:org_isolation:v1';

ALTER TABLE public.res_demand_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.res_demand_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.res_demand_lines
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.res_demand_lines IS 'openbooks:org_isolation:v1';

-- Replays may encounter an existing relation registration; the row is intentionally left intact.
INSERT INTO openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('res_assignments', '0423'),
  ('res_demand_lines', '0423'),
  ('res_requests', '0423')
ON CONFLICT (relation) DO NOTHING;
SELECT public.openbooks_refresh_query_catalog();
