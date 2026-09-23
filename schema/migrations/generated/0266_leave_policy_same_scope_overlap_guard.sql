-- OpenBooks forward migration 0266_leave_policy_same_scope_overlap_guard.
--
-- hrm_leave_policies accepted any number of ACTIVE windows for the same
-- (org, leave type, applies_to scope): two monthly rules in force on one
-- day resolved by sort internals (leave-math selectPolicy broke exact
-- effective_from ties arbitrarily), so the balance depended on row order
-- rather than on declared policy. Overlapping same-scope windows are never
-- meaningful — a successor closes the predecessor's window (effective_to),
-- it does not share days with it — while different-scope overlaps stay
-- legal and keep resolving by specificity (exact beats subsidiary-only
-- beats org-wide). 0194's comment said overlaps resolve service-side; that
-- stays true across scopes, but within one scope only storage can
-- arbitrate the READ COMMITTED race between two concurrent writers, which
-- is why 0250 converted the assignment table the same way.
--
-- Scope pins ride the 0194 STORED GENERATED columns
-- (applies_employer_subsidiary_id, applies_department_id) with a text
-- coalesce so two org-wide (NULL-pin) policies still collide: NULLs never
-- collide in a GiST equality, and without the coalesce the most common
-- duplicate — two org-wide windows — would escape the guard entirely.
-- Inactive rows are exempt (WHERE is_active): history and deactivated
-- drafts may keep whatever windows they hold; reactivating re-checks.
--
-- No existing row is expected to conflict (every writer paths through
-- createLeavePolicy, which preflights); the pre-check below refuses by
-- name, listing the offending pairs, rather than letting ADD CONSTRAINT
-- fail with a bare exclusion violation. Nothing is auto-deleted.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

DO $precheck$
DECLARE
  pair_count integer;
  offending text;
BEGIN
  SELECT count(*) INTO pair_count
    FROM public.hrm_leave_policies a
    JOIN public.hrm_leave_policies b
      ON a.org_id = b.org_id
     AND a.leave_type_id = b.leave_type_id
     AND coalesce(a.applies_employer_subsidiary_id::text, '') = coalesce(b.applies_employer_subsidiary_id::text, '')
     AND coalesce(a.applies_department_id::text, '') = coalesce(b.applies_department_id::text, '')
     AND a.id < b.id
     AND a.is_active AND b.is_active
     AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]');
  IF pair_count > 0 THEN
    SELECT string_agg(pair, E'\n') INTO offending FROM (
      SELECT format('leave type %s policies %s [%s, %s] and %s [%s, %s]',
               a.leave_type_id, a.id, a.effective_from, coalesce(a.effective_to::text, 'open'),
               b.id, b.effective_from, coalesce(b.effective_to::text, 'open')) AS pair
        FROM public.hrm_leave_policies a
        JOIN public.hrm_leave_policies b
          ON a.org_id = b.org_id
         AND a.leave_type_id = b.leave_type_id
         AND coalesce(a.applies_employer_subsidiary_id::text, '') = coalesce(b.applies_employer_subsidiary_id::text, '')
         AND coalesce(a.applies_department_id::text, '') = coalesce(b.applies_department_id::text, '')
         AND a.id < b.id
         AND a.is_active AND b.is_active
         AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]')
       LIMIT 5
    ) pairs;
    RAISE EXCEPTION E'hrm_leave_policies holds % overlapping active same-scope pair(s); close one window of each pair (set effective_to) or deactivate the duplicate policy before applying 0266. First pairs:\n%', pair_count, offending;
  END IF;
END;
$precheck$;

ALTER TABLE public.hrm_leave_policies
  ADD CONSTRAINT hrm_leave_policies_no_same_scope_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    leave_type_id WITH =,
    (coalesce(applies_employer_subsidiary_id::text, '')) WITH =,
    (coalesce(applies_department_id::text, '')) WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT hrm_leave_policies_no_same_scope_overlap ON public.hrm_leave_policies IS
  'One active effective window per (org, leave type, scope pins). Same-scope overlaps resolved arbitrarily by sort order before 0266; cross-scope overlaps stay legal and resolve by specificity (0266).';
