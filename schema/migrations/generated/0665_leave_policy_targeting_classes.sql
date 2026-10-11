-- OpenBooks forward migration 0665_leave_policy_targeting_classes.
--
-- hrm_leave_policies scopes by targeting class now: a pinned policy
-- (employment_ids or classification_ids present and non-empty) overlaps
-- the general policy of the same type and scope freely and resolves by
-- specificity, so the previous same-scope exclusion narrows to wildcard
-- pairs only. Empty arrays read as wildcard, matching the read path and
-- the writers, which refuse empty lists. Legacy rows without targeting
-- keys are wildcards, so the narrowed guard covers every pair the
-- previous guard covered that can still collide meaningfully.
--
-- No existing row is expected to conflict: the narrowed predicate is
-- strictly weaker than the previous guard's, so any database satisfying
-- the previous guard satisfies it. The pre-check below still refuses by
-- name, listing offending pairs, rather than letting ADD CONSTRAINT fail
-- bare. Nothing is auto-deleted.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

DO $precheck$
DECLARE
  clash record;
BEGIN
  FOR clash IN
    SELECT a.id AS a_id, b.id AS b_id
      FROM public.hrm_leave_policies a
      JOIN public.hrm_leave_policies b
        ON a.org_id = b.org_id
       AND a.leave_type_id = b.leave_type_id
       AND a.id < b.id
       AND coalesce(a.applies_employer_subsidiary_id::text, '') = coalesce(b.applies_employer_subsidiary_id::text, '')
       AND coalesce(a.applies_department_id::text, '') = coalesce(b.applies_department_id::text, '')
       AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]')
     WHERE a.is_active AND b.is_active
       AND ((a.applies_to -> 'employment_ids') IS NULL OR (a.applies_to -> 'employment_ids') = '[]'::jsonb)
       AND ((a.applies_to -> 'classification_ids') IS NULL OR (a.applies_to -> 'classification_ids') = '[]'::jsonb)
       AND ((b.applies_to -> 'employment_ids') IS NULL OR (b.applies_to -> 'employment_ids') = '[]'::jsonb)
       AND ((b.applies_to -> 'classification_ids') IS NULL OR (b.applies_to -> 'classification_ids') = '[]'::jsonb)
     LIMIT 5
  LOOP
    RAISE EXCEPTION 'leave policy windows % and % overlap untargeted — close one window before migrating', clash.a_id, clash.b_id;
  END LOOP;
END
$precheck$;

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
    AND ((applies_to -> 'employment_ids') IS NULL OR (applies_to -> 'employment_ids') = '[]'::jsonb)
    AND ((applies_to -> 'classification_ids') IS NULL OR (applies_to -> 'classification_ids') = '[]'::jsonb)
  );

COMMENT ON CONSTRAINT hrm_leave_policies_no_same_scope_overlap ON public.hrm_leave_policies IS
  'Untargeted (wildcard employment/classification) active windows stay exclusive per (org, leave type, scope): targeted policies overlap them freely and resolve by specificity, with the advisory-lock preflight refusing same-class intersecting sets by name.';
