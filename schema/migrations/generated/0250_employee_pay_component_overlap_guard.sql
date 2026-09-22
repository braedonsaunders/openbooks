-- OpenBooks forward migration 0250_employee_pay_component_overlap_guard.
--
-- employee_pay_components had no storage-level guard against two active
-- effective windows overlapping for the same assignment. The pay run reads it
-- with
--
--   select ... from employee_pay_components a
--    where a.org_id = ... and a.employee_party_id = ...
--      and a.is_active and a.effective_from <= period_end
--      and (a.effective_to is null or a.effective_to >= period_end)
--
-- (engine/src/payroll/run-stub-compute.ts) and emits a LINE PER MATCHING ROW.
-- Two overlapping active assignments therefore pay the employee twice — a
-- double-pay, not a display bug. Only storage can arbitrate the READ COMMITTED
-- race between two concurrent writers, which is why 0051 converted the nine
-- rate/policy tables to GiST exclusion constraints; this is the same guard for
-- the assignment table.
--
-- Business key (owner decision): (org_id, coalesce(employment_id,
-- employee_party_id), component_id). Keying on employment_id alone would let
-- every not-yet-stamped row (employment_id is nullable) escape the guard
-- entirely, because NULLs never collide in a GiST equality; folding to
-- employee_party_id when employment_id is NULL covers those rows too. A rehire
-- or a second concurrent employment still holds its own window, because its
-- employment_id differs. No backfill and no NOT NULL change: a row that is
-- later stamped is re-checked by the constraint on UPDATE, so the guard
-- tightens by itself as rows get stamped.
--
-- No existing row is expected to conflict (no production writer exists yet);
-- the pre-check below refuses by name if one does rather than letting ADD
-- CONSTRAINT fail with a bare exclusion violation.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

DO $precheck$
DECLARE
  conflicting integer;
BEGIN
  SELECT count(*) INTO conflicting
    FROM public.employee_pay_components a
    JOIN public.employee_pay_components b
      ON a.org_id = b.org_id
     AND coalesce(a.employment_id, a.employee_party_id) = coalesce(b.employment_id, b.employee_party_id)
     AND a.component_id = b.component_id
     AND a.id < b.id
     AND a.is_active AND b.is_active
     AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]');
  IF conflicting > 0 THEN
    RAISE EXCEPTION 'employee_pay_components holds % overlapping active assignment pair(s) on (org, coalesce(employment_id, employee_party_id), component); close or deactivate the duplicate windows before applying 0250', conflicting;
  END IF;
END;
$precheck$;

ALTER TABLE public.employee_pay_components
  ADD CONSTRAINT employee_pay_components_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    (coalesce(employment_id, employee_party_id)) WITH =,
    component_id WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT employee_pay_components_no_active_overlap ON public.employee_pay_components IS
  'One active effective window per (org, coalesce(employment_id, employee_party_id), component). The pay run sums every matching row, so an overlap is a double-pay; only storage can arbitrate the concurrent-writer race (0250).';