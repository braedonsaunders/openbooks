-- OpenBooks forward migration 0381_ledger_statement_balance_checks.
--
-- The per-row deferred balance checks (jl_balanced and
-- jl_balanced_by_subsidiary: one whole-entry re-sum per line, so an N-line
-- entry pays N re-sums at commit) become statement-level AFTER triggers
-- that validate each touched entry once per statement using transition
-- tables. PostgreSQL allows transition tables on single-event triggers
-- only, so INSERT, UPDATE, and DELETE each get their own trigger; all
-- three feed the same validator.
--
-- Scope, precisely. The validator checks each touched entry that is NOT a
-- draft, whole-entry and per subsidiary. Draft entries stay under the
-- retained deferred entry-level gate je_posted_balanced, which refuses an
-- unbalanced draft when it posts: guard-precedence tests insert single
-- unbalanced lines into drafts to prove tenant and account guards fire
-- first, and fixtures build drafts across statements, so per-statement
-- draft validation would forbid construction the ledger leaves mutable
-- (see 0380: drafts stay mutable). The commit-time invariant is unchanged:
-- no unbalanced entry can become visible, because every imbalance is
-- refused either at the statement (posted entries) or at posting (drafts).
--
-- This is sound because the ledger API (engine/src/ledger/post-entry.ts)
-- inserts all lines of an entry in ONE multi-row INSERT statement: a
-- posted write lands whole, and the trigger re-sums it exactly once.
--
-- Timing note: the old checks ran INITIALLY DEFERRED at commit; the new
-- checks run at the end of each writing statement. A statement that leaves
-- a posted entry unbalanced now fails at that statement instead of at
-- commit, with the same messages and errcodes (23514).
--
-- No data is touched.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP TRIGGER IF EXISTS jl_balanced ON public.journal_lines;
DROP TRIGGER IF EXISTS jl_balanced_by_subsidiary ON public.journal_lines;
DROP TRIGGER IF EXISTS journal_lines_balanced_stmt_ins ON public.journal_lines;
DROP TRIGGER IF EXISTS journal_lines_balanced_stmt_upd ON public.journal_lines;
DROP TRIGGER IF EXISTS journal_lines_balanced_stmt_del ON public.journal_lines;
DROP FUNCTION IF EXISTS public.jl_check_balanced();
DROP FUNCTION IF EXISTS public.jl_check_balanced_by_subsidiary();
DROP FUNCTION IF EXISTS public.journal_lines_check_balanced_entries(uuid[]);
DROP FUNCTION IF EXISTS public.journal_lines_check_balanced_stmt_ins();
DROP FUNCTION IF EXISTS public.journal_lines_check_balanced_stmt_upd();
DROP FUNCTION IF EXISTS public.journal_lines_check_balanced_stmt_del();

CREATE OR REPLACE FUNCTION public.journal_lines_check_balanced_entries(p_entry_ids uuid[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
  v_bad_entry uuid;
  v_bad_subsidiary uuid;
  v_bad_total numeric(19, 4);
begin
  -- Whole-entry balance, one re-sum per touched entry (not per line).
  select e.id, sum(l.amount)
    into v_bad_entry, v_bad_total
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
   where e.status is distinct from 'draft'
   group by e.id
  having sum(l.amount) <> 0
   limit 1;
  if found then
    raise exception 'journal entry % does not balance (sum = %)', v_bad_entry, v_bad_total
      using errcode = '23514';
  end if;
  -- Per-subsidiary balance for the same touched entries.
  select l.entry_id, l.subsidiary_id, sum(l.amount)
    into v_bad_entry, v_bad_subsidiary, v_bad_total
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
   where e.status is distinct from 'draft'
   group by l.entry_id, l.subsidiary_id
  having sum(l.amount) <> 0
   limit 1;
  if found then
    raise exception 'journal entry % does not balance for subsidiary % (sum = %)',
      v_bad_entry, v_bad_subsidiary, v_bad_total using errcode = '23514';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.journal_lines_check_balanced_stmt_ins() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform public.journal_lines_check_balanced_entries(
    array(select distinct entry_id from new_lines));
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.journal_lines_check_balanced_stmt_upd() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform public.journal_lines_check_balanced_entries(
    array(select distinct entry_id from new_lines
          union
          select distinct entry_id from old_lines));
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.journal_lines_check_balanced_stmt_del() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform public.journal_lines_check_balanced_entries(
    array(select distinct entry_id from old_lines));
  return null;
end $$;

CREATE TRIGGER journal_lines_balanced_stmt_ins
  AFTER INSERT ON public.journal_lines
  REFERENCING NEW TABLE AS new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.journal_lines_check_balanced_stmt_ins();

CREATE TRIGGER journal_lines_balanced_stmt_upd
  AFTER UPDATE ON public.journal_lines
  REFERENCING NEW TABLE AS new_lines OLD TABLE AS old_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.journal_lines_check_balanced_stmt_upd();

CREATE TRIGGER journal_lines_balanced_stmt_del
  AFTER DELETE ON public.journal_lines
  REFERENCING OLD TABLE AS old_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.journal_lines_check_balanced_stmt_del();
