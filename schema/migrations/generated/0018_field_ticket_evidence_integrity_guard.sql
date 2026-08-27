-- OpenBooks forward migration 0018_field_ticket_evidence_integrity_guard.
--
-- The baseline installs one trigger function on both evidence tables.  A
-- PL/pgSQL expression that mentions NEW.signature_file_id (or
-- NEW.email_log_id) is planned against the row type of the table that fired
-- the trigger, even when a TG_TABLE_NAME branch would have skipped it.  The
-- signature-request row has no signature_file_id, so the shared function
-- raised 42703 before a signing link could be created on a fresh install.
--
-- Read optional evidence fields from the row's JSON representation.  This
-- keeps one guard shared by both tables while avoiding plan-time references to
-- columns that are only present on one of them.  A missing required evidence
-- value resolves to NULL and therefore fails the same-org existence check.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.field_ticket_evidence_integrity_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_row jsonb;
  v_org_id uuid;
  v_field_ticket_id uuid;
  v_evidence_id uuid;
BEGIN
  -- to_jsonb(NEW) is safe for either trigger relation.  Keep the casts here so
  -- malformed identifiers fail closed rather than being treated as absent.
  v_row := to_jsonb(NEW);
  v_org_id := (v_row ->> 'org_id')::uuid;
  v_field_ticket_id := (v_row ->> 'field_ticket_id')::uuid;

  IF NOT EXISTS (
    SELECT 1
      FROM public.field_tickets ft
     WHERE ft.document_id = v_field_ticket_id
       AND ft.org_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'field ticket evidence must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'field_ticket_signatures' THEN
    v_evidence_id := NULLIF(v_row ->> 'signature_file_id', '')::uuid;
    IF v_evidence_id IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public.files f
       WHERE f.id = v_evidence_id
         AND f.org_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'field ticket signature file must belong to the same organization'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'field_ticket_signature_requests' THEN
    v_evidence_id := NULLIF(v_row ->> 'email_log_id', '')::uuid;
    IF v_evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM public.email_log e
       WHERE e.id = v_evidence_id
         AND e.org_id = v_org_id
    ) THEN
      RAISE EXCEPTION 'field ticket signature email evidence must belong to the same organization'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;
