-- OpenBooks forward migration 0646_time_approval_policies.
--
-- Organization time-approval policy: whether an approver may approve their
-- own timesheet (and a field ticket carrying their own crew time).
-- Effective-dated rows — the latest active row covering the week decides, so
-- a change never reinterprets already-approved history. An org with no row
-- prevents self-approval (default ON): a sole proprietor opts out with an
-- explicit row. Surfaced in Company Settings through the Setup registry
-- (time-approval-policies), whose generic CRUD audits every write.
--
-- No data or backfill: a new table, empty on arrival. Reapply-safe by
-- construction (create-if-absent objects only).

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.time_approval_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    prevent_self_approval boolean NOT NULL DEFAULT true,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT time_approval_policies_pkey PRIMARY KEY (id),
    CONSTRAINT time_approval_policies_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT time_approval_policies_date_order CHECK ((effective_to IS NULL) OR (effective_to >= effective_from))
);

CREATE INDEX time_approval_policies_org_effective ON public.time_approval_policies (org_id, effective_from DESC);

ALTER TABLE public.time_approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_approval_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.time_approval_policies
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.time_approval_policies IS 'openbooks:org_isolation:v1';

SELECT public.openbooks_refresh_query_catalog();
