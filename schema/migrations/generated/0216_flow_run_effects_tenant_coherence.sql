-- OpenBooks forward migration 0216_flow_run_effects_tenant_coherence.
--
-- The canonical baseline installed flow_run_effects_run_id_fkey as
-- FOREIGN KEY (run_id) REFERENCES flow_runs(id) ON DELETE CASCADE. That
-- proves only that the UUID exists. It does not prove that the referenced
-- run belongs to the effect's organization. flow_runs is org-scoped
-- (org_id NOT NULL, PK id) and is not a 0044 tenant anchor, so the catalog
-- rewrite never touches this edge. RLS WITH CHECK only compares the
-- child's org_id to the session GUC; it does not bind the referenced
-- run. An effect for organization A can therefore name a run owned by
-- organization B.
--
-- This forward-only repair replaces that edge with a composite
-- (org_id, run_id) foreign key. Existing evidence is never rewritten or
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

DO $flow_run_effects_tenant_preflight$
DECLARE
  violation record;
BEGIN
  SELECT effect.ctid::text AS child_ctid,
         effect.org_id::text AS child_org_id,
         effect.run_id::text AS run_id,
         run.org_id::text AS referenced_org_id
    INTO violation
    FROM public.flow_run_effects effect
    LEFT JOIN public.flow_runs run
      ON run.id = effect.run_id
   WHERE effect.run_id IS NOT NULL
     AND (run.id IS NULL OR run.org_id IS DISTINCT FROM effect.org_id)
   ORDER BY effect.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.flow_run_effects.run_id',
      DETAIL = jsonb_build_object(
        'table', 'flow_run_effects',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'run_id', violation.run_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the flow run effect run_id to a flow run owned by the same organization, then retry migration 0216; this migration will not rewrite financial history.';
  END IF;
END
$flow_run_effects_tenant_preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- flow_runs is keyed by id, so it needs its own tenant pair.
-- IF NOT EXISTS keeps a replay or an installation that already provisioned
-- the key (for example a sibling flow-child repair) from failing.
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_org_id_id_unique
  ON public.flow_runs USING btree (org_id, id);

COMMENT ON INDEX public.flow_runs_org_id_id_unique IS
  'openbooks:flow_runs.tenant_key:v1 - exact organization and id key required by tenant-coherent references';

-- Baseline's constraint has the same name but the wrong one-column shape.
-- Drop it before installing the tenant-coherent definition. The explicit
-- DROP also makes a replay converge from the already-correct shape.
ALTER TABLE public.flow_run_effects
  DROP CONSTRAINT IF EXISTS flow_run_effects_run_id_fkey;

ALTER TABLE public.flow_run_effects
  ADD CONSTRAINT flow_run_effects_run_id_fkey
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.flow_runs (org_id, id)
  ON DELETE CASCADE
  DEFERRABLE NOT VALID;

ALTER TABLE public.flow_run_effects
  VALIDATE CONSTRAINT flow_run_effects_run_id_fkey;

COMMENT ON CONSTRAINT flow_run_effects_run_id_fkey
  ON public.flow_run_effects IS
  'openbooks:flow_run_effects.run_tenant_coherence:v1 - run references must remain within the effect organization; same-tenant parent deletion cascades';
