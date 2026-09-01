-- OpenBooks forward migration 0084_recognition_event_tenant_coherence.
--
-- Migration 0062 created recognition_events with a globally-scoped
-- obligation_id foreign key. RLS filters the event row by its independently
-- supplied org_id, but cannot make that UUID reference tenant-coherent for
-- import, maintenance, or other direct writers. This forward repair replaces
-- that edge with a composite (org_id, obligation_id) foreign key so a row can
-- only reference an obligation owned by the same organization.
--
-- Existing evidence is never rewritten or discarded. The preflight reports
-- the first cross-organization or orphaned reference and aborts before any
-- constraint or index changes. Clean installations and upgrades then receive
-- the same storage invariant, and replay is idempotent.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $recognition_event_tenant_coherence_preflight$
DECLARE
  violation record;
BEGIN
  SELECT event.ctid::text AS event_ctid,
         event.org_id::text AS event_org_id,
         event.obligation_id::text AS obligation_id,
         obligation.org_id::text AS obligation_org_id
    INTO violation
    FROM public.recognition_events event
    LEFT JOIN public.performance_obligations obligation
      ON obligation.id = event.obligation_id
   WHERE obligation.id IS NULL
      OR obligation.org_id IS DISTINCT FROM event.org_id
   ORDER BY event.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.recognition_events.obligation_id',
      DETAIL = jsonb_build_object(
        'table', 'recognition_events',
        'row', violation.event_ctid,
        'org_id', violation.event_org_id,
        'obligation_id', violation.obligation_id,
        'obligation_org_id', violation.obligation_org_id
      )::text,
      HINT = 'Reconcile the recognition event to an obligation owned by the same organization, then retry migration 0084; this migration will not rewrite financial evidence.';
  END IF;
END
$recognition_event_tenant_coherence_preflight$;

-- PostgreSQL requires an exact unique key for every composite foreign key.
-- The conventional name is stable and IF NOT EXISTS keeps a replay or an
-- installation that already provisioned the key from failing needlessly.
CREATE UNIQUE INDEX IF NOT EXISTS performance_obligations_org_id_id_unique
  ON public.performance_obligations USING btree (org_id, id);

-- 0062's constraint has the same name but the wrong one-column shape. Drop it
-- before installing the tenant-coherent definition. The explicit DROP also
-- makes a replay converge from the already-correct shape.
ALTER TABLE public.recognition_events
  DROP CONSTRAINT IF EXISTS recognition_events_obligation_id_fkey;

ALTER TABLE public.recognition_events
  ADD CONSTRAINT recognition_events_obligation_id_fkey
  FOREIGN KEY (org_id, obligation_id)
  REFERENCES public.performance_obligations (org_id, id)
  ON DELETE CASCADE
  DEFERRABLE NOT VALID;

ALTER TABLE public.recognition_events
  VALIDATE CONSTRAINT recognition_events_obligation_id_fkey;

COMMENT ON CONSTRAINT recognition_events_obligation_id_fkey
  ON public.recognition_events IS
  'openbooks:recognition_events.tenant_coherence:v1 - obligation references must remain within the event organization; same-tenant parent deletion cascades';

COMMENT ON INDEX public.performance_obligations_org_id_id_unique IS
  'openbooks:performance_obligations.tenant_key:v1 - exact organization and id key required by tenant-coherent references';
