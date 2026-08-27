-- OpenBooks forward migration 0002_kernel_hardening.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively anyway: data-correcting DO blocks run
-- before any constraint that could reject live rows, and every statement
-- tolerates re-execution.
--
-- Sections:
--   1. Query-console function hardening (revoke PUBLIC file readers)
--   2. income_tax_rates effective-range exclusion constraint (+ data repair)
--   3. tax_rates effective-date uniqueness per code (+ data repair)
--   4. journal_entries (org_id, entry_number) integrity (+ data repair)
--   5. pay_application_lines.previous_materials_stored column

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Pin the path the baseline restores after each applied file, so unqualified
-- references below resolve deterministically regardless of session defaults.
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);


--
-- 1. Query-console function hardening.
--
-- The governed query console switches to the read-only openbooks_read role
-- before user SQL executes, but these pg_catalog server-file readers are
-- granted to PUBLIC by cluster default, so role grants alone would still let
-- console SQL read server files and logs. Revoke EXECUTE from PUBLIC on every
-- signature of pg_read_file / pg_read_binary_file / pg_ls_dir /
-- pg_current_logfile that exists in this cluster, discovered from pg_proc so
-- the statement set adapts across PostgreSQL versions whose signatures differ.
--
DO $query_console_file_access$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid AS oid, n.nspname AS nspname, p.proname AS proname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'pg_catalog'
       AND p.proname IN (
         'pg_read_file',
         'pg_read_binary_file',
         'pg_ls_dir',
         'pg_current_logfile'
       )
  LOOP
    EXECUTE format(
      'revoke execute on function %I.%I(%s) from public',
      fn.nspname,
      fn.proname,
      pg_catalog.pg_get_function_identity_arguments(fn.oid)
    );
  END LOOP;
EXCEPTION
  WHEN undefined_function THEN
    -- A discovered signature disappeared between catalog scan and revoke
    -- (concurrent version change): nothing left to revoke for it.
    NULL;
END
$query_console_file_access$;


--
-- 2. income_tax_rates effective-range exclusion.
--
-- Mirrors the 0051 convention (effective_date_overlap_exclusion_constraints)
-- for this table's scope: (org_id, jurisdiction, coalesce(subsidiary_id, zero
-- uuid)) plus date-range overlap. subsidiary_id NULL means org-wide (all
-- subsidiaries), so it folds into the same zero-uuid sentinel 0051 already
-- uses for nullable scope keys.
--
-- A BEFORE-trigger SELECT EXISTS check can never close the concurrency window:
-- under READ COMMITTED two concurrent overlapping active-rate inserts for the
-- same (org, jurisdiction, subsidiary) each see only committed rows, so both
-- pass the check and both commit parallel statutory configuration. The racy
-- guard is therefore retired here and replaced by a GiST exclusion constraint
-- that arbitrates the race in the index: the second conflicting writer waits
-- on the first transaction and is rejected with SQLSTATE 23P01 the moment it
-- commits — for API, import, pack, and direct writes alike.
--
-- Rollout order mirrors 0051 and is intentional:
--   1. retire the racy overlap check (the trigger is single-duty) so the data
--      repair below cannot trip per-row trigger re-reads of rows the same
--      repair statement is still closing;
--   2. repair rows that only a lost race could have produced — DESTRUCTIVE-
--      ISH: deletes shadow duplicate rate rows and truncates overlapping
--      ranges; both steps are logged via NOTICE for audit evidence.
--      a) Within each scope + effective_from group keep the newest row
--         (greatest id) and delete the older shadow duplicates.
--      b) For survivors ordered by effective_from, close an open or
--         overlapping effective_to to the day before the next effective_from.
--         Rows already closed before their successor are untouched.
--         next_from > effective_from implies next_from - 1 >= effective_from,
--         so the income_tax_rates_valid_range check keeps holding.
--   3. add the constraint, which now sees a repaired, representable state.
--
-- The range constructor mirrors effective_date_ranges_overlap (0001_baseline)
-- byte for byte: inclusive bounds on both sides, NULL effective_to open-ended
-- as 'infinity'::date.

-- UUID/text/date equality operator classes for GiST come from btree_gist.
-- Mandatory for the same reason as 0023: silently omitting it would silently
-- omit statutory-rate configuration invariants.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- Retired through IF EXISTS rather than bare DROP so the statement set is a
-- no-op on databases where this revision is the first 0002 they ever ran, and
-- a real retirement where the former digest installed the guard.
DROP TRIGGER IF EXISTS income_tax_rates_no_overlap ON public.income_tax_rates;
DROP FUNCTION IF EXISTS public.income_tax_rates_no_overlap_guard();

DO $income_tax_rates_repair$
DECLARE
  v_shadows_deleted integer := 0;
  v_rows_closed integer := 0;
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY org_id,
                          coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          jurisdiction,
                          effective_from
             ORDER BY id DESC
           ) AS shadow_rank
      FROM public.income_tax_rates
  ), deleted AS (
    DELETE FROM public.income_tax_rates r
     USING ranked s
     WHERE s.id = r.id
       AND s.shadow_rank > 1
     RETURNING r.id
  )
  SELECT count(*) INTO v_shadows_deleted FROM deleted;

  WITH ordered AS (
    SELECT id,
           lead(effective_from) OVER (
             PARTITION BY org_id,
                          coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          jurisdiction
             ORDER BY effective_from, id
           ) AS next_from
      FROM public.income_tax_rates
  ), closed AS (
    UPDATE public.income_tax_rates r
       SET effective_to = o.next_from - 1
      FROM ordered o
     WHERE o.id = r.id
       AND o.next_from IS NOT NULL
       AND (r.effective_to IS NULL OR r.effective_to >= o.next_from)
     RETURNING r.id
  )
  SELECT count(*) INTO v_rows_closed FROM closed;

  RAISE NOTICE 'income_tax_rates repair: % shadow duplicate(s) deleted, % range(s) closed before successor',
    v_shadows_deleted, v_rows_closed;
END
$income_tax_rates_repair$;

-- Installed through a catalog check rather than a bare ADD CONSTRAINT so a
-- re-run of this file is a no-op instead of an error.
DO $income_tax_rates_constraint_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'income_tax_rates'
       AND c.conname = 'income_tax_rates_no_active_overlap'
  ) THEN
    ALTER TABLE public.income_tax_rates
      ADD CONSTRAINT income_tax_rates_no_active_overlap
      EXCLUDE USING gist (
        org_id WITH =,
        jurisdiction WITH =,
        (coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
        (daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]')) WITH &&
      )
      WHERE (is_active);
  END IF;
END
$income_tax_rates_constraint_install$;

COMMENT ON CONSTRAINT income_tax_rates_no_active_overlap
  ON public.income_tax_rates IS
  'openbooks:income_tax_rates_no_active_overlap:v1 - one active income-tax rate window per jurisdiction and subsidiary scope; a NULL subsidiary is org-wide and a NULL effective_to is open-ended';


--
-- 3. tax_rates effective-date uniqueness per code.
--
-- DATA REPAIR FIRST — DESTRUCTIVE-ISH: exact-duplicate (tax_code_id,
-- effective_from) rows are deleted, keeping the newest id per group. Nothing
-- references tax_rates(id) by foreign key in the canonical baseline, so the
-- deletions cannot orphan dependents. Logged via NOTICE for audit evidence.
DO $tax_rates_repair$
DECLARE
  v_duplicates_deleted integer := 0;
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY tax_code_id, effective_from
             ORDER BY id DESC
           ) AS dup_rank
      FROM public.tax_rates
  ), deleted AS (
    DELETE FROM public.tax_rates r
     USING ranked d
     WHERE d.id = r.id
       AND d.dup_rank > 1
     RETURNING r.id
  )
  SELECT count(*) INTO v_duplicates_deleted FROM deleted;

  RAISE NOTICE 'tax_rates repair: % exact-duplicate row(s) deleted (kept newest id per code + effective_from)',
    v_duplicates_deleted;
END
$tax_rates_repair$;

CREATE UNIQUE INDEX IF NOT EXISTS tax_rates_code_effective
    ON public.tax_rates USING btree (tax_code_id, effective_from);


--
-- 4. journal_entries entry_number integrity.
--
-- DATA REPAIR FIRST — DESTRUCTIVE-ISH: renames duplicate entry numbers within
-- an organization. The first occurrence per (org_id, entry_number) group in id
-- order keeps its number; later occurrences get '-R1', '-R2', … appended. If a
-- suffixed candidate would itself collide with an existing number, the suffix
-- counter increments until free, so the rename set is deterministic and
-- collision-free against arbitrary pre-existing data. Foreign keys reference
-- journal_entries(id), never entry_number, so renames break nothing. Logged
-- via NOTICE for audit evidence.
DO $journal_entry_number_repair$
DECLARE
  rec record;
  v_suffix integer;
  v_candidate text;
  v_renamed integer := 0;
BEGIN
  FOR rec IN
    SELECT j.id, j.org_id, j.entry_number,
           row_number() OVER (PARTITION BY j.org_id, j.entry_number ORDER BY j.id) AS rn
      FROM public.journal_entries j
     WHERE j.entry_number IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.journal_entries d
          WHERE d.org_id = j.org_id
            AND d.entry_number = j.entry_number
          HAVING count(*) > 1
       )
  LOOP
    IF rec.rn = 1 THEN CONTINUE; END IF;
    v_suffix := rec.rn - 1;
    LOOP
      v_candidate := rec.entry_number || '-R' || v_suffix::text;
      EXIT WHEN NOT EXISTS (
        SELECT 1
          FROM public.journal_entries e
         WHERE e.org_id = rec.org_id
           AND e.entry_number = v_candidate
      );
      v_suffix := v_suffix + 1;
    END LOOP;
    UPDATE public.journal_entries
       SET entry_number = v_candidate
     WHERE id = rec.id;
    v_renamed := v_renamed + 1;
  END LOOP;

  RAISE NOTICE 'journal_entries repair: % duplicate entry number(s) renamed with -R suffixes', v_renamed;
END
$journal_entry_number_repair$;

-- Naming follows documents_org_kind_number. entry_number is NOT NULL today
-- (schema/src/ledger.ts); the partial predicate is kept deliberately — it
-- documents intent and keeps the index correct if nullability ever relaxes.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_org_number
    ON public.journal_entries USING btree (org_id, entry_number)
    WHERE entry_number IS NOT NULL;


--
-- 5. pay_application_lines.previous_materials_stored.
--
-- Mirrors vendor_pay_application_lines.previous_materials_stored
-- (schema/src/subcontracts.ts): cumulative materials-stored basis so customer
-- applications can net stored-to-date instead of re-billing it. A later code
-- change consumes this column. PostgreSQL 11+ applies NOT NULL DEFAULT as
-- metadata plus fast default, but the brief ACCESS EXCLUSIVE lock still
-- queues behind readers on a busy table.
ALTER TABLE public.pay_application_lines
    ADD COLUMN IF NOT EXISTS previous_materials_stored numeric(19,4) NOT NULL DEFAULT '0';
