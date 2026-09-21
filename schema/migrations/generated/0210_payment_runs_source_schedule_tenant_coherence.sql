-- OpenBooks forward migration 0210_payment_runs_source_schedule_tenant_coherence.
--
-- The canonical baseline installed payment_runs_source_schedule_id_fkey as
-- FOREIGN KEY (source_schedule_id) REFERENCES payment_schedules(id). That
-- proves only that the UUID exists. It does not prove that the referenced
-- schedule belongs to the run's organization. payment_schedules is org-scoped
-- (org_id NOT NULL, PK id) and is not a 0044 tenant anchor, so the catalog
-- rewrite never touches this edge. RLS WITH CHECK only compares the run's
-- org_id to the session GUC; it does not bind the referenced schedule. A
-- payment run for organization A can therefore name a schedule owned by
-- organization B.
--
-- This forward-only repair replaces that edge with a composite
-- (org_id, source_schedule_id) foreign key. Existing evidence is never
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

DO $payment_runs_source_schedule_tenant_preflight$
DECLARE
  violation record;
BEGIN
  SELECT payment_run.ctid::text AS child_ctid,
         payment_run.org_id::text AS child_org_id,
         payment_run.source_schedule_id::text AS source_schedule_id,
         schedule.org_id::text AS referenced_org_id
    INTO violation
    FROM public.payment_runs payment_run
    LEFT JOIN public.payment_schedules schedule
      ON schedule.id = payment_run.source_schedule_id
   WHERE payment_run.source_schedule_id IS NOT NULL
     AND (schedule.id IS NULL OR schedule.org_id IS DISTINCT FROM payment_run.org_id)
   ORDER BY payment_run.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.payment_runs.source_schedule_id',
      DETAIL = jsonb_build_object(
        'table', 'payment_runs',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'source_schedule_id', violation.source_schedule_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the payment run source_schedule_id to a schedule owned by the same organization, then retry migration 0210; this migration will not rewrite financial history.';
  END IF;
END
$payment_runs_source_schedule_tenant_preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- payment_schedules is keyed by id, so it needs its own tenant pair.
-- IF NOT EXISTS keeps a replay or an installation that already provisioned
-- the key (for example a sibling schedule-child repair) from failing.
CREATE UNIQUE INDEX IF NOT EXISTS payment_schedules_org_id_id_unique
  ON public.payment_schedules USING btree (org_id, id);

COMMENT ON INDEX public.payment_schedules_org_id_id_unique IS
  'openbooks:payment_schedules.tenant_key:v1 - exact organization and id key required by tenant-coherent references';

-- Baseline's constraint has the same name but the wrong one-column shape.
-- Drop it before installing the tenant-coherent definition. The explicit
-- DROP also makes a replay converge from the already-correct shape.
ALTER TABLE public.payment_runs
  DROP CONSTRAINT IF EXISTS payment_runs_source_schedule_id_fkey;

ALTER TABLE public.payment_runs
  ADD CONSTRAINT payment_runs_source_schedule_id_fkey
  FOREIGN KEY (org_id, source_schedule_id)
  REFERENCES public.payment_schedules (org_id, id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.payment_runs
  VALIDATE CONSTRAINT payment_runs_source_schedule_id_fkey;

COMMENT ON CONSTRAINT payment_runs_source_schedule_id_fkey
  ON public.payment_runs IS
  'openbooks:payment_runs.source_schedule_tenant_coherence:v1 - source schedule references must remain within the payment-run organization';
