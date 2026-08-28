-- OpenBooks forward migration 0071_information_return_root_uniqueness.
--
-- information_return_filings.subsidiary_id is nullable because a filing may
-- belong to the organization root.  The old four-column unique index did not
-- make that root identity unique: PostgreSQL treats each NULL key as distinct,
-- so two competing root filings could be created for one year and form.
--
-- This migration also closes the renewal race in compliance_records.  The web
-- renewal path inserts a pending successor and then marks the predecessor
-- superseded.  A row-level guard serializes that predecessor transition and
-- rejects a second successor after the first one commits.  An AFTER trigger
-- records the predecessor's before/after status and pointer in audit_log, so
-- the renewal lineage is reconstructable even when the caller only logs the
-- successor insert.
--
-- Rollout is fail-closed and data preserving.  The preflight names any legacy
-- filing identity collision and aborts before dropping the old index or
-- installing new enforcement; it never chooses a winning filing or rewrites
-- history.  Bootstrap applies this file in one transaction, and every DDL
-- statement below is safe to replay after a successful application.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $information_return_filings_preflight$
DECLARE
  violation record;
BEGIN
  SELECT *
    INTO violation
    FROM (
      SELECT 'information_return_filings.root_identity'::text AS invariant,
             f.org_id,
             f.tax_year,
             f.form_type,
             (array_agg(f.id ORDER BY f.id))::text[] AS row_ids
        FROM public.information_return_filings f
       WHERE f.subsidiary_id IS NULL
       GROUP BY f.org_id, f.tax_year, f.form_type
      HAVING count(*) > 1
      UNION ALL
      SELECT 'information_return_filings.subsidiary_identity'::text,
             f.org_id,
             f.tax_year,
             f.form_type,
             (array_agg(f.id ORDER BY f.id))::text[]
        FROM public.information_return_filings f
       WHERE f.subsidiary_id IS NOT NULL
       GROUP BY f.org_id, f.tax_year, f.form_type, f.subsidiary_id
      HAVING count(*) > 1
    ) duplicates
   ORDER BY invariant, org_id, tax_year, form_type
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format('legacy information-return filings duplicate a natural key: %s', violation.invariant),
      DETAIL = jsonb_build_object(
        'invariant', violation.invariant,
        'org_id', violation.org_id,
        'tax_year', violation.tax_year,
        'form_type', violation.form_type,
        'row_ids', violation.row_ids
      )::text,
      HINT = 'Review the identified filings, void or correct the losing artifact with an audited product action, then retry migration 0071. This migration never picks a winning filing.';
  END IF;
END
$information_return_filings_preflight$;

-- Retire the nullable four-column index and recreate both explicit scopes.
-- Dropping the named partial indexes first makes replay deterministic even if a
-- prior attempt created one index before a client disconnected.
DROP INDEX IF EXISTS public.information_return_filings_unique;
DROP INDEX IF EXISTS public.information_return_filings_unique_root;
DROP INDEX IF EXISTS public.information_return_filings_unique_sub;

CREATE UNIQUE INDEX information_return_filings_unique_root
  ON public.information_return_filings USING btree (org_id, tax_year, form_type)
  WHERE subsidiary_id IS NULL;

CREATE UNIQUE INDEX information_return_filings_unique_sub
  ON public.information_return_filings USING btree (org_id, tax_year, form_type, subsidiary_id)
  WHERE subsidiary_id IS NOT NULL;

COMMENT ON INDEX public.information_return_filings_unique_root IS
  'openbooks:information_return_root_uniqueness:v1 - exactly one organization-root information return per tax year and form type';

COMMENT ON INDEX public.information_return_filings_unique_sub IS
  'openbooks:information_return_root_uniqueness:v1 - exactly one subsidiary information return per tax year, form type, and subsidiary';

CREATE OR REPLACE FUNCTION public.compliance_record_renewal_guard() RETURNS trigger
    LANGUAGE plpgsql
    VOLATILE
    AS $compliance_record_renewal_guard$
DECLARE
  successor public.compliance_records%ROWTYPE;
BEGIN
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION
      'a superseded compliance record cannot be reinstated'
      USING ERRCODE = '23514';
  END IF;

  -- A renewal is the only legal operation that fills superseded_by_id.  The
  -- UPDATE row lock serializes competing transactions on the predecessor; the
  -- second waiter then sees the committed superseded state and is rejected.
  IF NEW.superseded_by_id IS NOT DISTINCT FROM OLD.superseded_by_id THEN
    IF NEW.status = 'superseded' AND NEW.superseded_by_id IS NULL THEN
      RAISE EXCEPTION
        'a superseded compliance record must identify its pending successor'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.superseded_by_id IS NULL THEN
    RAISE EXCEPTION
      'a compliance record supersession pointer cannot be cleared'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'superseded' OR OLD.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION
      'compliance record % has already been superseded; renew the current record instead',
      OLD.id
      USING ERRCODE = '23505';
  END IF;

  IF NEW.status <> 'superseded' THEN
    RAISE EXCEPTION
      'a compliance renewal must mark its predecessor superseded'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.superseded_by_id = NEW.id THEN
    RAISE EXCEPTION
      'a compliance record cannot supersede itself'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO successor
    FROM public.compliance_records
   WHERE id = NEW.superseded_by_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'compliance renewal successor % does not exist',
      NEW.superseded_by_id
      USING ERRCODE = '23503';
  END IF;

  IF successor.org_id IS DISTINCT FROM NEW.org_id
     OR successor.party_id IS DISTINCT FROM NEW.party_id
     OR successor.requirement_id IS DISTINCT FROM NEW.requirement_id
     OR successor.project_id IS DISTINCT FROM NEW.project_id
     OR successor.status <> 'pending_review'
     OR successor.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION
      'compliance renewal successor % must be a pending record for the same organization, vendor, requirement, and project',
      NEW.superseded_by_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$compliance_record_renewal_guard$;

COMMENT ON FUNCTION public.compliance_record_renewal_guard() IS
  'openbooks:compliance_record_renewal_guard:v1 - serializes predecessor supersession, rejects competing successors, and validates same-scope pending successor identity';

CREATE OR REPLACE FUNCTION public.compliance_record_renewal_audit() RETURNS trigger
    LANGUAGE plpgsql
    VOLATILE
    AS $compliance_record_renewal_audit$
BEGIN
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id
     AND NEW.superseded_by_id IS NOT NULL THEN
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
    VALUES (
      NEW.org_id,
      'compliance_records',
      NEW.id,
      'supersede',
      jsonb_build_object(
        'before', jsonb_build_object(
          'status', OLD.status,
          'supersededById', OLD.superseded_by_id
        ),
        'after', jsonb_build_object(
          'status', NEW.status,
          'supersededById', NEW.superseded_by_id
        )
      ),
      NEW.updated_by
    );
  END IF;
  RETURN NEW;
END
$compliance_record_renewal_audit$;

COMMENT ON FUNCTION public.compliance_record_renewal_audit() IS
  'openbooks:compliance_record_renewal_audit:v1 - append-only before/after evidence for the predecessor mutation in a certificate renewal';

DROP TRIGGER IF EXISTS compliance_record_renewal_guard ON public.compliance_records;
CREATE TRIGGER compliance_record_renewal_guard
  BEFORE UPDATE OF status, superseded_by_id ON public.compliance_records
  FOR EACH ROW
  EXECUTE FUNCTION public.compliance_record_renewal_guard();

DROP TRIGGER IF EXISTS compliance_record_renewal_audit ON public.compliance_records;
CREATE TRIGGER compliance_record_renewal_audit
  AFTER UPDATE OF status, superseded_by_id ON public.compliance_records
  FOR EACH ROW
  EXECUTE FUNCTION public.compliance_record_renewal_audit();
