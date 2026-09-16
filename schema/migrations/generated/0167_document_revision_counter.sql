-- OpenBooks forward migration 0167_document_revision_counter.
--
-- Optimistic-concurrency revision tokens are projected from `updated_at`, an
-- editable business timestamp. Migration 0013_document_revision_monotonic
-- advances `updated_at` when a write would repeat the stored value, but it
-- permits an explicitly BACKWARD timestamp: a backdated write keeps an older
-- display time while still committing new content, so two committed revisions
-- can share ordering assumptions every OCC holder relies on and a stale token
-- can compare equal against newer content. The revision contract must be
-- strictly increasing and distinct from any editable business timestamp.
--
-- This migration introduces `revision_seq` (bigint, default 0) on every table
-- whose rows carry a revision token compared by the product's
-- optimistic-concurrency checks: documents, wip_prebill_lines, ap_capture_items,
-- custom_records, and crm_opportunities. A single trigger function bumps the
-- counter on EVERY update, so any committed change — including a backdated
-- one — advances the token. Existing rows backfill 0 (the column default);
-- distinctness going forward is what the contract requires, and every
-- revision reader projects the counter from here on while `updated_at` stays
-- a display timestamp only.
--
-- Additive change only: one NOT NULL DEFAULT column plus one BEFORE UPDATE
-- trigger per table. No rows are rewritten, no history reinterpreted, and the
-- 0013 equality bump on `updated_at` is untouched.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS revision_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE public.wip_prebill_lines
  ADD COLUMN IF NOT EXISTS revision_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE public.ap_capture_items
  ADD COLUMN IF NOT EXISTS revision_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE public.custom_records
  ADD COLUMN IF NOT EXISTS revision_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE public.crm_opportunities
  ADD COLUMN IF NOT EXISTS revision_seq bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.openbooks_bump_revision_seq() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Every committed UPDATE is a new revision, even one that backdates the
  -- display timestamp: the counter only moves forward, so a stale
  -- revision-seq token can never compare equal against newer content.
  NEW.revision_seq := OLD.revision_seq + 1;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.openbooks_bump_revision_seq() IS
  'openbooks:revision_seq:v1 - strictly increasing optimistic-concurrency counter; bumped on every UPDATE of a revisioned row (documents, wip_prebill_lines, ap_capture_items, custom_records, crm_opportunities), independent of the editable updated_at display timestamp';

-- One install block per table, each a re-run no-op through the catalog check
-- from 0013_document_revision_monotonic.
DO $documents_revision_seq_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'documents'
       AND t.tgname = 'documents_revision_seq'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER documents_revision_seq
      BEFORE UPDATE ON public.documents
      FOR EACH ROW EXECUTE FUNCTION public.openbooks_bump_revision_seq();
  END IF;
END
$documents_revision_seq_install$;

DO $wip_prebill_lines_revision_seq_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'wip_prebill_lines'
       AND t.tgname = 'wip_prebill_lines_revision_seq'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER wip_prebill_lines_revision_seq
      BEFORE UPDATE ON public.wip_prebill_lines
      FOR EACH ROW EXECUTE FUNCTION public.openbooks_bump_revision_seq();
  END IF;
END
$wip_prebill_lines_revision_seq_install$;

DO $ap_capture_items_revision_seq_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'ap_capture_items'
       AND t.tgname = 'ap_capture_items_revision_seq'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER ap_capture_items_revision_seq
      BEFORE UPDATE ON public.ap_capture_items
      FOR EACH ROW EXECUTE FUNCTION public.openbooks_bump_revision_seq();
  END IF;
END
$ap_capture_items_revision_seq_install$;

DO $custom_records_revision_seq_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'custom_records'
       AND t.tgname = 'custom_records_revision_seq'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER custom_records_revision_seq
      BEFORE UPDATE ON public.custom_records
      FOR EACH ROW EXECUTE FUNCTION public.openbooks_bump_revision_seq();
  END IF;
END
$custom_records_revision_seq_install$;

DO $crm_opportunities_revision_seq_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'crm_opportunities'
       AND t.tgname = 'crm_opportunities_revision_seq'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER crm_opportunities_revision_seq
      BEFORE UPDATE ON public.crm_opportunities
      FOR EACH ROW EXECUTE FUNCTION public.openbooks_bump_revision_seq();
  END IF;
END
$crm_opportunities_revision_seq_install$;
