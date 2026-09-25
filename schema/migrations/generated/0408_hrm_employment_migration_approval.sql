-- OpenBooks forward migration 0408_hrm_employment_migration_approval.
-- Operator employer/date mapping sets approve through Flows, never by
-- free-text self-assertion: one row binds the SHA-256 digest of the exact
-- mapping set under review and serves as the Flows approval subject
-- (subject_kind 'hrm_employment_migration_mapping'). The migration
-- preflight and apply verify the deciding gate (approved, human decider
-- distinct from the applier) against this row's digest before any mapped
-- candidate is applicable.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.hrm_employment_migration_approvals (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  mapping_digest text NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  requested_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_employment_migration_approvals_pkey PRIMARY KEY (id),
  CONSTRAINT hrm_employment_migration_approvals_digest_check
    CHECK (mapping_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hrm_employment_migration_approvals_status_check
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected')),
  CONSTRAINT hrm_employment_migration_approvals_digest_unique
    UNIQUE (org_id, mapping_digest)
);

ALTER TABLE public.hrm_employment_migration_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_employment_migration_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.hrm_employment_migration_approvals
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.hrm_employment_migration_approvals IS
  'One Flows approval subject per reviewed operator mapping set: mapping_digest pins the exact set the approver saw; status mirrors the Flows decision (release-owned, never hand-edited).';
COMMENT ON COLUMN public.hrm_employment_migration_approvals.mapping_digest IS
  'SHA-256 hex over the canonical encoding of the sorted mapping set (party, employer, service dates); free-text approver metadata is never part of the digest.';
