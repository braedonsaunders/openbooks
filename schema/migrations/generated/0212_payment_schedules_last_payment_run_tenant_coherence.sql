-- OpenBooks forward migration 0212_payment_schedules_last_payment_run_tenant_coherence.
--
-- The canonical baseline installed payment_schedules_last_payment_run_id_fkey
-- as FOREIGN KEY (last_payment_run_id) REFERENCES payment_runs(id). That
-- proves only that the UUID exists. It does not prove that the referenced
-- payment run belongs to the schedule's organization. payment_runs is
-- org-scoped (org_id NOT NULL, PK id) and is not a 0044 tenant anchor, so
-- the catalog rewrite never touches this edge. RLS WITH CHECK only compares
-- the schedule's org_id to the session GUC; it does not bind the referenced
-- run. A payment schedule for organization A can therefore name a last
-- payment run owned by organization B.
--
-- This forward-only repair replaces that edge with a composite
-- (org_id, last_payment_run_id) foreign key. Existing evidence is never
-- rewritten or discarded. The preflight reports the first cross-organization
-- or orphaned pointer and aborts before any constraint or index changes.
-- Clean installations and upgrades then receive the same storage invariant,
-- and replay converges by dropping the prior shape before installing the
-- composite definition.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $payment_schedules_last_payment_run_tenant_preflight$
DECLARE
  violation record;
BEGIN
  SELECT schedule.ctid::text AS child_ctid,
         schedule.org_id::text AS child_org_id,
         schedule.last_payment_run_id::text AS last_payment_run_id,
         payment_run.org_id::text AS referenced_org_id
    INTO violation
    FROM public.payment_schedules schedule
    LEFT JOIN public.payment_runs payment_run
      ON payment_run.id = schedule.last_payment_run_id
   WHERE schedule.last_payment_run_id IS NOT NULL
     AND (payment_run.id IS NULL OR payment_run.org_id IS DISTINCT FROM schedule.org_id)
   ORDER BY schedule.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.payment_schedules.last_payment_run_id',
      DETAIL = jsonb_build_object(
        'table', 'payment_schedules',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'last_payment_run_id', violation.last_payment_run_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the payment schedule last_payment_run_id to a payment run owned by the same organization, then retry migration 0212; this migration will not rewrite financial history.';
  END IF;
END
$payment_schedules_last_payment_run_tenant_preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- payment_runs is keyed by id, so it needs its own tenant pair.
-- IF NOT EXISTS keeps a replay or an installation that already provisioned
-- the key (for example a sibling run-child repair) from failing.
CREATE UNIQUE INDEX IF NOT EXISTS payment_runs_org_id_id_unique
  ON public.payment_runs USING btree (org_id, id);

COMMENT ON INDEX public.payment_runs_org_id_id_unique IS
  'openbooks:payment_runs.tenant_key:v1 - exact organization and id key required by tenant-coherent references';

-- Baseline's constraint has the same name but the wrong one-column shape.
-- Drop it before installing the tenant-coherent definition. The explicit
-- DROP also makes a replay converge from the already-correct shape.
ALTER TABLE public.payment_schedules
  DROP CONSTRAINT IF EXISTS payment_schedules_last_payment_run_id_fkey;

ALTER TABLE public.payment_schedules
  ADD CONSTRAINT payment_schedules_last_payment_run_id_fkey
  FOREIGN KEY (org_id, last_payment_run_id)
  REFERENCES public.payment_runs (org_id, id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.payment_schedules
  VALIDATE CONSTRAINT payment_schedules_last_payment_run_id_fkey;

COMMENT ON CONSTRAINT payment_schedules_last_payment_run_id_fkey
  ON public.payment_schedules IS
  'openbooks:payment_schedules.last_payment_run_tenant_coherence:v1 - last payment run references must remain within the schedule organization';
