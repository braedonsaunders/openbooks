-- OpenBooks forward migration 0218_pay_run_adjustments_component_tenant_coherence.
--
-- The canonical baseline installed pay_run_adjustments_component_fkey as
-- FOREIGN KEY (component_id) REFERENCES pay_components(id). That
-- proves only that the UUID exists. It does not prove that the referenced
-- pay component belongs to the adjustment's organization. pay_components is
-- org-scoped (org_id NOT NULL, PK id) and is not a 0044 tenant anchor — 0044
-- rewrites single-column edges into anchors whose parent column is id, so
-- this edge is never touched. RLS WITH CHECK only compares the child org_id
-- to the session GUC; it does not bind the referenced component. A
-- line adjustment can therefore store org A with an org-B component_id.
--
-- This forward-only repair replaces that edge with a composite
-- (org_id, component_id) foreign key. Existing evidence is never
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

DO $pay_run_adjustments_component_tenant_preflight$
DECLARE
  violation record;
BEGIN
  SELECT adjustment.ctid::text AS child_ctid,
         adjustment.org_id::text AS child_org_id,
         adjustment.component_id::text AS component_id,
         component.org_id::text AS referenced_org_id
    INTO violation
    FROM public.pay_run_adjustments adjustment
    LEFT JOIN public.pay_components component
      ON component.id = adjustment.component_id
   WHERE adjustment.component_id IS NOT NULL
     AND (component.id IS NULL OR component.org_id IS DISTINCT FROM adjustment.org_id)
   ORDER BY adjustment.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.pay_run_adjustments.component_id',
      DETAIL = jsonb_build_object(
        'table', 'pay_run_adjustments',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'component_id', violation.component_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the pay-run adjustment component_id to a pay component owned by the same organization, then retry migration 0218; this migration will not rewrite financial history.';
  END IF;
END
$pay_run_adjustments_component_tenant_preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- pay_components is keyed by id, so it needs its own tenant pair.
-- IF NOT EXISTS keeps a replay or an installation that already provisioned
-- the key (for example a sibling pay-component child repair) from failing.
CREATE UNIQUE INDEX IF NOT EXISTS pay_components_org_id_id_unique
  ON public.pay_components USING btree (org_id, id);

COMMENT ON INDEX public.pay_components_org_id_id_unique IS
  'openbooks:pay_components.tenant_key:v1 - exact organization and id key required by tenant-coherent references';

-- Baseline's constraint has the same name but the wrong one-column shape.
-- Drop it before installing the tenant-coherent definition. The explicit
-- DROP also makes a replay converge from the already-correct shape.
ALTER TABLE public.pay_run_adjustments
  DROP CONSTRAINT IF EXISTS pay_run_adjustments_component_fkey;

ALTER TABLE public.pay_run_adjustments
  ADD CONSTRAINT pay_run_adjustments_component_fkey
  FOREIGN KEY (org_id, component_id)
  REFERENCES public.pay_components (org_id, id)
  ON DELETE CASCADE
  DEFERRABLE NOT VALID;

ALTER TABLE public.pay_run_adjustments
  VALIDATE CONSTRAINT pay_run_adjustments_component_fkey;

COMMENT ON CONSTRAINT pay_run_adjustments_component_fkey
  ON public.pay_run_adjustments IS
  'openbooks:pay_run_adjustments.component_tenant_coherence:v1 - pay component references must remain within the adjustment organization; same-tenant parent deletion cascades';
