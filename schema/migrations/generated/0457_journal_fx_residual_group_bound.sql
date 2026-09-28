-- OpenBooks forward migration 0457_journal_fx_residual_group_bound.
--
-- The per-line jl_fx_consistent CHECK (abs(amount - round(txn_amount *
-- fx_rate, 4)) <= 0.005, from the baseline) is preserved byte-for-byte: it
-- stays the local corruption guard for a single mistranslated line. It
-- cannot see the rounding the posting kernel deliberately leaves behind:
-- absorbFxRoundingResidual folds each subsidiary's translation residual
-- (at most half a ledger unit per line, so at most count(*) * 0.00005 per
-- entry and subsidiary) onto one bucket line, whose stored deviation from
-- its exact translation can therefore exceed 0.0001 while remaining lawful.
--
-- This migration enforces that group bound in storage, partitioned by
-- organization, journal entry, and subsidiary — subsidiaries never
-- subsidize each other, and entries never blend. Enforcement mirrors
-- migration 0381 exactly: statement-level AFTER triggers on journal_lines
-- (INSERT, UPDATE, and DELETE each get their own trigger, because
-- PostgreSQL allows transition tables on single-event triggers only)
-- validate each touched non-draft entry once per statement, while drafts —
-- which fixtures and guard-precedence tests build across statements — stay
-- mutable under the retained deferred entry-level gate
-- je_check_posted_balance, extended here with the same group check so the
-- draft -> posted flip sees the complete entry. The check reuses
-- PostgreSQL round(), the same function jl_fx_consistent uses: no second
-- arithmetic algorithm, no null coercion (txn_amount and fx_rate are
-- NOT NULL with writer defaults on every write path).
--
-- No data is touched.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Preflight: refuse the upgrade while a visible entry already violates the
-- bound (the 0457 preflight file lists them one row per entry/subsidiary),
-- and refuse when je_check_posted_balance no longer carries the 0038 body
-- this migration extends. A reshaped gate blocks the upgrade by name
-- instead of persisting a half-rewritten body.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  def text := pg_catalog.pg_get_functiondef('public.je_check_posted_balance()'::regprocedure);
  v_violations integer;
BEGIN
  IF def NOT LIKE '%must contain at least two lines%' THEN
    RAISE EXCEPTION '0457 preflight: public.je_check_posted_balance() no longer carries the 0038 body; rebase this migration on its current body and re-run.';
  END IF;
  SELECT count(*) INTO v_violations FROM (
    SELECT 1
      FROM public.journal_lines l
      JOIN public.journal_entries e ON e.id = l.entry_id
     WHERE e.status IN ('posted', 'reversed')
     GROUP BY l.org_id, l.entry_id, l.subsidiary_id
    HAVING sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4))) > count(*) * 0.00005
  ) v;
  IF v_violations > 0 THEN
    RAISE EXCEPTION '0457 preflight: % posted entry/subsidiary groups exceed the FX group bound; run schema/migrations/preflight/0457_journal_fx_residual_group_bound.sql and correct them through the ledger API before retrying the upgrade.', v_violations;
  END IF;
END
$preflight$;

DROP TRIGGER IF EXISTS journal_lines_fx_residual_stmt_ins ON public.journal_lines;
DROP TRIGGER IF EXISTS journal_lines_fx_residual_stmt_upd ON public.journal_lines;
DROP TRIGGER IF EXISTS journal_lines_fx_residual_stmt_del ON public.journal_lines;
DROP FUNCTION IF EXISTS public.journal_lines_check_fx_residual_entries(uuid[]);
DROP FUNCTION IF EXISTS public.journal_lines_check_fx_residual_stmt_ins();
DROP FUNCTION IF EXISTS public.journal_lines_check_fx_residual_stmt_upd();
DROP FUNCTION IF EXISTS public.journal_lines_check_fx_residual_stmt_del();

CREATE OR REPLACE FUNCTION public.journal_lines_check_fx_residual_entries(p_entry_ids uuid[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
  v_bad_org uuid;
  v_bad_entry uuid;
  v_bad_subsidiary uuid;
  v_bad_deviation numeric(19, 4);
  v_bad_lines integer;
  v_bad_bound numeric;
begin
  -- One re-sum per touched (org, entry, subsidiary) group, not per line.
  -- Drafts are skipped: they post through je_check_posted_balance below.
  select l.org_id, l.entry_id, l.subsidiary_id,
         sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4))),
         count(*), count(*) * 0.00005
    into v_bad_org, v_bad_entry, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
   where e.status is distinct from 'draft'
   group by l.org_id, l.entry_id, l.subsidiary_id
  having sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4))) > count(*) * 0.00005
   limit 1;
  if found then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): correct through the ledger API by posting a reversal and reposting instead of editing history',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.journal_lines_check_fx_residual_stmt_ins() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform public.journal_lines_check_fx_residual_entries(
    array(select distinct entry_id from new_lines));
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.journal_lines_check_fx_residual_stmt_upd() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform public.journal_lines_check_fx_residual_entries(
    array(select distinct entry_id from new_lines
          union
          select distinct entry_id from old_lines));
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.journal_lines_check_fx_residual_stmt_del() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform public.journal_lines_check_fx_residual_entries(
    array(select distinct entry_id from old_lines));
  return null;
end $$;

CREATE TRIGGER journal_lines_fx_residual_stmt_ins
  AFTER INSERT ON public.journal_lines
  REFERENCING NEW TABLE AS new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.journal_lines_check_fx_residual_stmt_ins();

CREATE TRIGGER journal_lines_fx_residual_stmt_upd
  AFTER UPDATE ON public.journal_lines
  REFERENCING NEW TABLE AS new_lines OLD TABLE AS old_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.journal_lines_check_fx_residual_stmt_upd();

CREATE TRIGGER journal_lines_fx_residual_stmt_del
  AFTER DELETE ON public.journal_lines
  REFERENCING OLD TABLE AS old_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.journal_lines_check_fx_residual_stmt_del();

-- ---------------------------------------------------------------------------
-- Draft -> posted finalization: the 0038 body is preserved line for line and
-- gains the FX group check between the per-subsidiary balance and the
-- two-line floor, so a draft carrying a lawful balance but an unlawful
-- residual is refused at posting with the entry, subsidiary, deviation,
-- bound, and remedy named.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.je_check_posted_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_sum numeric(19,4);
  v_bad record;
  v_fx record;
begin
  if new.status <> 'posted' then return null; end if;
  select coalesce(sum(amount), 0) into v_sum
    from journal_lines
   where entry_id = new.id and org_id = new.org_id;
  if v_sum <> 0 then
    raise exception 'posted journal entry % does not balance (sum = %)', new.id, v_sum
      using errcode = '23514';
  end if;
  select subsidiary_id, sum(amount) as total into v_bad
    from journal_lines
   where entry_id = new.id and org_id = new.org_id
   group by subsidiary_id having sum(amount) <> 0 limit 1;
  if found then
    raise exception 'posted journal entry % does not balance for subsidiary % (sum = %)',
      new.id, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
  end if;
  select subsidiary_id,
         sum(abs(amount - round(txn_amount * fx_rate, 4))) as deviation,
         count(*) as lines,
         count(*) * 0.00005 as bound into v_fx
    from journal_lines
   where entry_id = new.id and org_id = new.org_id
   group by subsidiary_id
  having sum(abs(amount - round(txn_amount * fx_rate, 4))) > count(*) * 0.00005 limit 1;
  if found then
    raise exception 'posted journal entry % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): correct through the ledger API by posting a reversal and reposting instead of editing history',
      new.id, v_fx.subsidiary_id, v_fx.deviation, v_fx.lines, v_fx.bound using errcode = '23514';
  end if;
  if (select count(*) from journal_lines where entry_id = new.id and org_id = new.org_id) < 2 then
    raise exception 'posted journal entry % must contain at least two lines', new.id
      using errcode = '23514';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Assertion: the migrated gate carries the FX branch and all three
-- statement triggers exist. je_guard is intentionally untouched: it owns
-- period and module fences, never amount arithmetic.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  def text := pg_catalog.pg_get_functiondef('public.je_check_posted_balance()'::regprocedure);
BEGIN
  IF def NOT LIKE '%per-entry FX rounding bound%' THEN
    RAISE EXCEPTION '0457 assertion failed: public.je_check_posted_balance() carries no FX group branch.';
  END IF;
  IF def NOT LIKE '%must contain at least two lines%' THEN
    RAISE EXCEPTION '0457 assertion failed: public.je_check_posted_balance() lost its 0038 body.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'journal_lines_fx_residual_stmt_ins')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'journal_lines_fx_residual_stmt_upd')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'journal_lines_fx_residual_stmt_del') THEN
    RAISE EXCEPTION '0457 assertion failed: the journal_lines FX residual statement triggers are missing.';
  END IF;
END
$assert$;
