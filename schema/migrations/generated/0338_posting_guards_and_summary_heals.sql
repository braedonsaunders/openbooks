-- OpenBooks forward migration 0338_posting_guards_and_summary_heals.
--
-- Audit wave G (database layer), posting-guard and derived-summary
-- sections (0334 carried the RLS section). Sections land in this file under
-- successive commits; the header names only landed sections. Each section
-- names its finding and stays re-runnable: every statement tolerates
-- re-execution.
--
-- Section G4: refuse posted -> draft on documents in storage.
-- The documents_posted_financial_guard trigger fires only on financial
-- columns, never status, so UPDATE documents SET status='draft' WHERE
-- status='posted' rewrote posted history with no amend flag: posted-only
-- readers (statements, registers, aging) silently lost the document while
-- its journal entry stayed posted. The only sanctioned exits from posted
-- are the controlled void (posted -> voided with void evidence in the same
-- write, engine/src/ledger/document-void.ts) and the governed amend path.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Section G4: a posted document leaves posted only by void or amend.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.posted_document_status_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    return new;
  end if;
  if openbooks_sandbox_wipe_allowed(old.org_id) then
    return new;
  end if;
  -- The controlled void writes its evidence (voided_at, voided_by,
  -- void_reason) in the same statement that flips the status; the row CHECK
  -- documents_void_reason_required enforces the same triple at commit.
  if new.status = 'voided'
     and new.voided_at is not null
     and new.voided_by is not null
     and new.void_reason is not null then
    return new;
  end if;
  if coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
    return new;
  end if;
  raise exception 'document % is posted and immutable — void it through the controlled void path instead of changing its status to %', old.id, new.status;
end $$;

DROP TRIGGER IF EXISTS documents_posted_status_guard ON public.documents;
CREATE TRIGGER documents_posted_status_guard BEFORE UPDATE OF status ON public.documents
FOR EACH ROW WHEN (old.status = 'posted' AND new.status IS DISTINCT FROM old.status)
EXECUTE FUNCTION public.posted_document_status_guard();
