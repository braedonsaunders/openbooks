-- OpenBooks forward migration 0209_pay_stubs_pay_run_tenant_coherence.
--
-- The canonical baseline installed pay_stubs_pay_run_document_id_fkey as
-- FOREIGN KEY (pay_run_document_id) REFERENCES pay_runs(document_id). That
-- proves only that the UUID exists. It does not prove that the referenced
-- pay run belongs to the stub's organization. pay_runs is org-scoped
-- (org_id NOT NULL, PK document_id) and is not a 0044 tenant anchor — 0044
-- rewrites single-column edges into anchors whose parent column is id, so
-- this edge is never touched. RLS WITH CHECK only compares the child org_id
-- to the session GUC; it does not bind the referenced pay run. A stub can
-- therefore store org A with an org-B pay_run document_id.
--
-- This forward-only repair replaces that edge with a composite
-- (org_id, pay_run_document_id) foreign key. Existing evidence is never
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

DO $pay_stubs_pay_run_tenant_preflight$
DECLARE
  violation record;
BEGIN
  SELECT stub.ctid::text AS child_ctid,
         stub.org_id::text AS child_org_id,
         stub.pay_run_document_id::text AS pay_run_document_id,
         pay_run.org_id::text AS referenced_org_id
    INTO violation
    FROM public.pay_stubs stub
    LEFT JOIN public.pay_runs pay_run
      ON pay_run.document_id = stub.pay_run_document_id
   WHERE stub.pay_run_document_id IS NOT NULL
     AND (pay_run.document_id IS NULL OR pay_run.org_id IS DISTINCT FROM stub.org_id)
   ORDER BY stub.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.pay_stubs.pay_run_document_id',
      DETAIL = jsonb_build_object(
        'table', 'pay_stubs',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'pay_run_document_id', violation.pay_run_document_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the pay stub pay_run_document_id to a pay run owned by the same organization, then retry migration 0209; this migration will not rewrite financial history.';
  END IF;
END
$pay_stubs_pay_run_tenant_preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- pay_runs is keyed by document_id, not id, so it needs its own tenant pair.
-- IF NOT EXISTS keeps a replay or an installation that already provisioned
-- the key (for example a sibling pay-run child repair) from failing.
CREATE UNIQUE INDEX IF NOT EXISTS pay_runs_org_id_document_id_unique
  ON public.pay_runs USING btree (org_id, document_id);

COMMENT ON INDEX public.pay_runs_org_id_document_id_unique IS
  'openbooks:pay_runs.tenant_key:v1 - exact organization and document_id key required by tenant-coherent references';

-- Baseline's constraint has the same name but the wrong one-column shape.
-- Drop it before installing the tenant-coherent definition. The explicit
-- DROP also makes a replay converge from the already-correct shape.
ALTER TABLE public.pay_stubs
  DROP CONSTRAINT IF EXISTS pay_stubs_pay_run_document_id_fkey;

ALTER TABLE public.pay_stubs
  ADD CONSTRAINT pay_stubs_pay_run_document_id_fkey
  FOREIGN KEY (org_id, pay_run_document_id)
  REFERENCES public.pay_runs (org_id, document_id)
  ON DELETE CASCADE
  DEFERRABLE NOT VALID;

ALTER TABLE public.pay_stubs
  VALIDATE CONSTRAINT pay_stubs_pay_run_document_id_fkey;

COMMENT ON CONSTRAINT pay_stubs_pay_run_document_id_fkey
  ON public.pay_stubs IS
  'openbooks:pay_stubs.pay_run_tenant_coherence:v1 - pay run references must remain within the stub organization; same-tenant parent deletion cascades';
