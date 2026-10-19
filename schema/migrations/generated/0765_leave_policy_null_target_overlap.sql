-- Untargeted leave policies retain one active effective window per legal
-- scope, including the explicit JSON null targets written by native services.
-- Policy rows and their recorded entitlement history are preserved.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.hrm_leave_policies
  DROP CONSTRAINT hrm_leave_policies_no_same_scope_overlap;

ALTER TABLE public.hrm_leave_policies
  ADD CONSTRAINT hrm_leave_policies_no_same_scope_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    leave_type_id WITH =,
    (coalesce(applies_employer_subsidiary_id::text, '')) WITH =,
    (coalesce(applies_department_id::text, '')) WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (
    is_active
    AND coalesce(applies_to -> 'employment_ids', 'null'::jsonb) IN ('null'::jsonb, '[]'::jsonb)
    AND coalesce(applies_to -> 'classification_ids', 'null'::jsonb) IN ('null'::jsonb, '[]'::jsonb)
  );

COMMENT ON CONSTRAINT hrm_leave_policies_no_same_scope_overlap ON public.hrm_leave_policies IS
  'Untargeted active leave policy windows are exclusive per organization, leave type and scope; missing, JSON null and empty target arrays all mean every eligible worker.';
