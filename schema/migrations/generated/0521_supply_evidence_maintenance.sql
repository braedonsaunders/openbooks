-- OpenBooks forward migration 0521_supply_evidence_maintenance.
-- Give the supply-evidence guard the same governed-maintenance escape hatch
-- the goods-tax guards carry: governed teardown and repair (bypass with the
-- amend flag) may remove evidence rows, while every ordinary write still
-- requires a draft parent. No row is read, rewritten or deleted.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.document_supply_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document_state text;
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  SELECT d.status INTO document_state FROM public.documents d
    WHERE d.org_id = COALESCE(NEW.org_id, OLD.org_id)
      AND d.id = COALESCE(NEW.document_id, OLD.document_id);
  IF document_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'supply evidence is immutable once the document leaves draft; return the document to draft and recollect its evidence';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
