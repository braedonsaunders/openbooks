-- OpenBooks forward migration 0214_flow_gates_tenant_coherence.
--
-- The canonical baseline installed flow_gates_flow_id_fkey as
-- FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE and
-- flow_gates_run_id_fkey as FOREIGN KEY (run_id) REFERENCES flow_runs(id)
-- ON DELETE CASCADE. Those prove only that the UUIDs exist. They do not
-- prove that the referenced flow or run belongs to the gate's
-- organization. flows and flow_runs are org-scoped (org_id NOT NULL,
-- PK id) and are not 0044 tenant anchors, so the catalog rewrite never
-- touches these edges. RLS WITH CHECK only compares the child's org_id
-- to the session GUC; it does not bind the referenced flow or run. A
-- gate for organization A can therefore name a flow or run owned by
-- organization B.
--
-- This forward-only repair replaces those edges with composite
-- (org_id, flow_id) and (org_id, run_id) foreign keys. Existing
-- evidence is never rewritten or discarded. The preflight reports the
-- first cross-organization or orphaned pointer and aborts before any
-- constraint or index changes. Clean installations and upgrades then
-- receive the same storage invariant, and replay converges by dropping
-- the prior shape before installing the composite definition.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $flow_gates_tenant_preflight$
DECLARE
  violation record;
BEGIN
  SELECT gate.ctid::text AS child_ctid,
         gate.org_id::text AS child_org_id,
         gate.flow_id::text AS flow_id,
         flow.org_id::text AS referenced_org_id
    INTO violation
    FROM public.flow_gates gate
    LEFT JOIN public.flows flow
      ON flow.id = gate.flow_id
   WHERE gate.flow_id IS NOT NULL
     AND (flow.id IS NULL OR flow.org_id IS DISTINCT FROM gate.org_id)
   ORDER BY gate.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.flow_gates.flow_id',
      DETAIL = jsonb_build_object(
        'table', 'flow_gates',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'flow_id', violation.flow_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the flow gate flow_id to a flow owned by the same organization, then retry migration 0214; this migration will not rewrite financial history.';
  END IF;

  SELECT gate.ctid::text AS child_ctid,
         gate.org_id::text AS child_org_id,
         gate.run_id::text AS run_id,
         run.org_id::text AS referenced_org_id
    INTO violation
    FROM public.flow_gates gate
    LEFT JOIN public.flow_runs run
      ON run.id = gate.run_id
   WHERE gate.run_id IS NOT NULL
     AND (run.id IS NULL OR run.org_id IS DISTINCT FROM gate.org_id)
   ORDER BY gate.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.flow_gates.run_id',
      DETAIL = jsonb_build_object(
        'table', 'flow_gates',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'run_id', violation.run_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the flow gate run_id to a flow run owned by the same organization, then retry migration 0214; this migration will not rewrite financial history.';
  END IF;
END
$flow_gates_tenant_preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- flows and flow_runs are keyed by id, so each needs its own tenant pair.
-- IF NOT EXISTS keeps a replay or an installation that already provisioned
-- the key (for example a sibling flow-child repair) from failing.
CREATE UNIQUE INDEX IF NOT EXISTS flows_org_id_id_unique
  ON public.flows USING btree (org_id, id);

COMMENT ON INDEX public.flows_org_id_id_unique IS
  'openbooks:flows.tenant_key:v1 - exact organization and id key required by tenant-coherent references';

CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_org_id_id_unique
  ON public.flow_runs USING btree (org_id, id);

COMMENT ON INDEX public.flow_runs_org_id_id_unique IS
  'openbooks:flow_runs.tenant_key:v1 - exact organization and id key required by tenant-coherent references';

-- Baseline's constraints have the same names but the wrong one-column
-- shape. Drop them before installing the tenant-coherent definitions.
-- The explicit DROP also makes a replay converge from the already-correct
-- shape.
ALTER TABLE public.flow_gates
  DROP CONSTRAINT IF EXISTS flow_gates_flow_id_fkey;

ALTER TABLE public.flow_gates
  ADD CONSTRAINT flow_gates_flow_id_fkey
  FOREIGN KEY (org_id, flow_id)
  REFERENCES public.flows (org_id, id)
  ON DELETE CASCADE
  DEFERRABLE NOT VALID;

ALTER TABLE public.flow_gates
  VALIDATE CONSTRAINT flow_gates_flow_id_fkey;

COMMENT ON CONSTRAINT flow_gates_flow_id_fkey
  ON public.flow_gates IS
  'openbooks:flow_gates.flow_tenant_coherence:v1 - flow references must remain within the gate organization; same-tenant parent deletion cascades';

ALTER TABLE public.flow_gates
  DROP CONSTRAINT IF EXISTS flow_gates_run_id_fkey;

ALTER TABLE public.flow_gates
  ADD CONSTRAINT flow_gates_run_id_fkey
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.flow_runs (org_id, id)
  ON DELETE CASCADE
  DEFERRABLE NOT VALID;

ALTER TABLE public.flow_gates
  VALIDATE CONSTRAINT flow_gates_run_id_fkey;

COMMENT ON CONSTRAINT flow_gates_run_id_fkey
  ON public.flow_gates IS
  'openbooks:flow_gates.run_tenant_coherence:v1 - run references must remain within the gate organization; same-tenant parent deletion cascades';
