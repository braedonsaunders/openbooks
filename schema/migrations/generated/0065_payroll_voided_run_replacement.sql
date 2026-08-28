-- OpenBooks forward migration 0065_payroll_voided_run_replacement.
--
-- A regular pay run is a posted document with an immutable payroll subledger.
-- Voiding reverses its financial/evidence effects, but must not delete or
-- rewrite the original run. The old partial unique index keyed every regular
-- run, including voided history, so an employer could never open a corrected
-- run for the same schedule period. The live-run key below excludes only the
-- explicit voided lifecycle state; draft, calculated, and committed runs still
-- serialize the period exactly as before.
--
-- The document and pay_runs rows are separate extensions. The trigger keeps
-- their lifecycle state coherent even for a direct document status transition
-- (the controlled payroll void path already writes run_status in the same
-- transaction). The backfill makes pre-migration voided documents eligible for
-- replacement without changing any stub, journal, or audit evidence.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP INDEX IF EXISTS public.pay_runs_schedule_period;

-- Retire historical runs whose parent document was already voided before this
-- migration. This changes only the lifecycle counter used by payroll queries;
-- the run, stubs, journals, and document remain intact for audit.
UPDATE public.pay_runs r
   SET run_status = 'voided',
       updated_at = COALESCE(d.voided_at, now()),
       updated_by = COALESCE(d.voided_by, d.updated_by)
  FROM public.documents d
 WHERE d.id = r.document_id
   AND d.org_id = r.org_id
   AND d.kind = 'pay_run'
   AND d.status = 'voided'
   AND r.run_status <> 'voided';

CREATE UNIQUE INDEX pay_runs_schedule_period
    ON public.pay_runs USING btree (org_id, pay_schedule_id, period_end)
    WHERE run_type = 'regular'::text
      AND run_status <> 'voided'::text;

COMMENT ON INDEX public.pay_runs_schedule_period IS
  'openbooks: one live regular pay run per organization, schedule, and period end; voided runs remain immutable history and release the period for an exact replacement';

CREATE OR REPLACE FUNCTION public.pay_runs_sync_voided_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.kind = 'pay_run' AND NEW.status = 'voided' THEN
    UPDATE public.pay_runs
       SET run_status = 'voided',
           updated_at = now(),
           updated_by = COALESCE(NEW.voided_by, NEW.updated_by)
     WHERE document_id = NEW.id
       AND org_id = NEW.org_id
       AND run_status <> 'voided';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pay_runs_sync_voided_document() IS
  'openbooks: mirror a pay_run document void into pay_runs.run_status so the live-period key releases while the historical run remains immutable';

DROP TRIGGER IF EXISTS documents_pay_run_voided_sync ON public.documents;
CREATE TRIGGER documents_pay_run_voided_sync
  AFTER UPDATE OF status ON public.documents
  FOR EACH ROW
  WHEN (NEW.kind = 'pay_run'::text AND NEW.status = 'voided'::text)
  EXECUTE FUNCTION public.pay_runs_sync_voided_document();
