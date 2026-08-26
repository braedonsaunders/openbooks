-- OpenBooks forward migration 0022_close_posting_fence.
--
-- Period close did not serialize with an in-flight journal posting. The
-- draft->posted branch of je_guard consulted period_locks without holding
-- anything across its [check -> commit] window, so a posting transaction that
-- passed the open-period trigger and paused before committing could land AFTER
-- a concurrent close committed 'closed' — posted ledger activity inside a
-- locked period that approval sign-off and the run's data fingerprint never
-- evaluated. The close service refreshed its evidence before it ever reached
-- the lock writes, so nothing re-examined the ledger after such a posting.
--
-- This migration installs the kernel side of a shared fence on the SAME
-- advisory key the engine's lock-state writers already take exclusively
-- ('period-lock:<org>:<period>:<book>', see periodScopeAdvisoryLock in
-- engine/src/close.ts):
--
--   * every journal mutation that consults GL period state first takes the
--     fence in SHARED mode and holds it to commit (pg_advisory_xact_lock is
--     transaction-scoped). Parallel postings stay parallel — shared/shared
--     never conflicts;
--   * a writer flipping locks to 'closed' holds the EXCLUSIVE side across its
--     whole validation-and-commit window, so an in-flight posting either
--     commits before that writer's final refresh (the refreshed fingerprint
--     and readiness checks include it) or arrives afterwards and is rejected
--     here with 'period is closed for GL posting'.
--
-- period_posting_fence is deliberately VOLATILE: statements inside a volatile
-- function take a fresh snapshot, so a posting that waited out the exclusive
-- side evaluates period_locks as of AFTER the close committed instead of as of
-- its own statement start. je_guard keeps every prior rule byte-for-byte; only
-- the fence acquisitions are new.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.period_posting_fence(p_org uuid, p_period uuid, p_book uuid) RETURNS void
    LANGUAGE plpgsql VOLATILE
    AS $$
BEGIN
  -- Shared side of the close/posting fence. Transaction-scoped by design:
  -- held until this transaction commits or rolls back, pinning the
  -- [period-state check -> commit] window of every journal mutation against
  -- concurrent lock-state transitions taken through the exclusive side.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('period-lock:' || p_org::text || ':' || p_period::text || ':' || p_book::text, 0)
  );
END;
$$;

COMMENT ON FUNCTION public.period_posting_fence(uuid, uuid, uuid) IS
  'openbooks:close_posting_fence:v1 - shared side of the period-close serialization fence; conflicts with the exclusive periodScopeAdvisoryLock held by close/reopen writers so a journal write either lands before their final refresh or is rejected after they commit';

CREATE OR REPLACE FUNCTION public.je_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if openbooks_sandbox_wipe_allowed(old.org_id) then return old; end if;
    -- Deleting a transaction removes its journal entry too. That is the one
    -- legitimate removal of a posted entry, done by the engine's guarded
    -- delete under the 'openbooks.amend' flag (after it has proven the delete
    -- is safe: open period, no applied payments, no downstream conversion).
    if old.status <> 'draft'
       and coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    if old.status <> 'draft' then
      perform period_posting_fence(old.org_id, old.period_id, old.book_id);
      if period_module_is_closed(old.org_id, old.period_id, old.book_id,
           nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl') then
        raise exception 'period is closed for GL posting';
      end if;
    end if;
    return old;
  end if;

  -- A document-sourced entry is a DERIVED projection of its source document:
  -- entry = postingRules(document), re-materialized on every save. When
  -- 'openbooks.amend' is on (set only by the engine's materialize path), a
  -- posted entry's header may be regenerated in place. It normally requires an
  -- OPEN period; source replay can cross only source-owned imported locks. A reversed original is
  -- still posted ledger history, so it uses the same guarded path while
  -- remaining reversed. Balance + summary-account rules still apply.
  if old.status in ('posted', 'reversed') and new.status = old.status
     and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
    perform period_posting_fence(old.org_id, old.period_id, old.book_id);
    perform period_posting_fence(new.org_id, new.period_id, new.book_id);
    if period_module_blocks_write(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       or period_module_blocks_write(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
      raise exception 'period is closed for GL posting';
    end if;
    return new;
  end if;

  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable', old.id;
  end if;
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;

  -- draft -> posted: period must be open for GL. The shared fence is taken
  -- BEFORE the state read and held to commit, so this check can no longer be
  -- overtaken by a concurrent close: either the close waits behind this
  -- posting (and re-reads the ledger including it), or this posting waits out
  -- the close and the fresh snapshot below sees 'closed'.
  if old.status = 'draft' and new.status = 'posted' then
    perform period_posting_fence(new.org_id, new.period_id, new.book_id);
    if period_module_blocks_write(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       or exists (
         select 1 from journal_lines l
          where l.entry_id = new.id
            and period_module_blocks_write(new.org_id, new.period_id, new.book_id,
              nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl',
              coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       ) then
      raise exception 'period is closed for GL posting';
    end if;
    new.posted_at := now();
  end if;
  return new;
end $$;

COMMENT ON FUNCTION public.je_guard() IS
  'openbooks:je_guard:v2 - kernel guard for journal entry mutations; v2 takes the shared close/posting fence before consulting GL period state so an in-flight posting serializes against period close instead of racing it';
