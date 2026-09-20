-- OpenBooks forward migration 0212_flow_runs_flow_tenant_coherence.
--
-- The canonical baseline installed flow_runs_flow_id_fkey as
-- FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE. That
-- proves only that the UUID exists. It does not prove that the referenced
-- flow belongs to the run's organization. flows is org-scoped
-- (org_id NOT NULL, PK id) and is not a 0044 tenant anchor, so the catalog
-- rewrite never touches this edge. RLS WITH CHECK only compares the
-- child's org_id to the session GUC; it does not bind the referenced
-- flow. A run for organization A can therefore name a flow owned by
-- organization B.
--
-- This forward-only repair replaces that edge with a composite
-- (org_id, flow_id) foreign key. Existing evidence is never rewritten or
-- discarded. The preflight reports the first cross-organization or
-- orphaned pointer and aborts before any constraint or index changes.
-- Clean installations and upgrades then receive the same storage
-- invariant, and replay converges by dropping the prior shape before
-- installing the composite definition.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $flow_runs_flow_tenant_preflight$
DECLARE
  violation record;
BEGIN
  SELECT run.ctid::text AS child_ctid,
         run.org_id::text AS child_org_id,
         run.flow_id::text AS flow_id,
         flow.org_id::text AS referenced_org_id
    INTO violation
    FROM public.flow_runs run
    LEFT JOIN public.flows flow
      ON flow.id = run.flow_id
   WHERE run.flow_id IS NOT NULL
     AND (flow.id IS NULL OR flow.org_id IS DISTINCT FROM run.org_id)
   ORDER BY run.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.flow_runs.flow_id',
      DETAIL = jsonb_build_object(
        'table', 'flow_runs',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'flow_id', violation.flow_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the flow run flow_id to a flow owned by the same organization, then retry migration 0212; this migration will not rewrite financial history.';
  END IF;
END
$flow_runs_flow_tenant_preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- flows is keyed by id, so it needs its own tenant pair.
-- IF NOT EXISTS keeps a replay or an installation that already provisioned
-- the key (for example a sibling flow-child repair) from failing.
CREATE UNIQUE INDEX IF NOT EXISTS flows_org_id_id_unique
  ON public.flows USING btree (org_id, id);

COMMENT ON INDEX public.flows_org_id_id_unique IS
  'openbooks:flows.tenant_key:v1 - exact organization and id key required by tenant-coherent references';

-- Baseline's constraint has the same name but the wrong one-column shape.
-- Drop it before installing the tenant-coherent definition. The explicit
-- DROP also makes a replay converge from the already-correct shape.
ALTER TABLE public.flow_runs
  DROP CONSTRAINT IF EXISTS flow_runs_flow_id_fkey;

ALTER TABLE public.flow_runs
  ADD CONSTRAINT flow_runs_flow_id_fkey
  FOREIGN KEY (org_id, flow_id)
  REFERENCES public.flows (org_id, id)
  ON DELETE CASCADE
  DEFERRABLE NOT VALID;

ALTER TABLE public.flow_runs
  VALIDATE CONSTRAINT flow_runs_flow_id_fkey;

COMMENT ON CONSTRAINT flow_runs_flow_id_fkey
  ON public.flow_runs IS
  'openbooks:flow_runs.flow_tenant_coherence:v1 - flow references must remain within the run organization; same-tenant parent deletion cascades';
