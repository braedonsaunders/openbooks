-- OpenBooks forward migration 0405_je_guard_module_fence.
--
-- JE-GUARD-MODULE-FENCE: migration 0380 re-created je_guard() from the
-- stale 0078 base text, silently dropping 0168's source-module recheck on
-- draft -> posted (the live body kept 0168's owning comment but no branch).
-- A module-only close could therefore commit between the app boundary's
-- check and the journal flip while GL stayed open, and the flip landed
-- inside a closed module. This migration rebuilds the 0168 v_module branch
-- onto the live 0400 body, which is otherwise preserved byte-for-byte
-- (0400 reversal/clone branches, 0402 predicate calls untouched).
--
-- CREATE OR REPLACE converges on re-run; the preflight then refuses as
-- superseded (fail closed) and the assertion still passes.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Preflight: the live body must still be the shape 0405 was authored
-- against (0400 body, no module branch yet). A reshaped guard blocks the
-- upgrade by name instead of persisting a half-rewritten body.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  def text := pg_catalog.pg_get_functiondef('public.je_guard()'::regprocedure);
BEGIN
  IF def NOT LIKE '%Branch: draft-post (f2/0168 owns the source-module recheck inside this block)%' THEN
    RAISE EXCEPTION '0405 preflight: public.je_guard() no longer carries the 0400 draft-post block; rebase this migration on its current body and re-run.';
  END IF;
  IF def LIKE '%v_module%' THEN
    RAISE EXCEPTION '0405 preflight: public.je_guard() already names v_module; this migration is superseded, do not apply it.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.je_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_module text;
begin
  -- Branch: journal-entry-delete (sandbox-wipe passthrough, posted/reversed delete fence).
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if tg_op = 'DELETE' then
    -- Append-only (0380): a posted or reversed entry cannot be deleted, with
    -- no session-flag escape. Corrections reverse and repost; they never
    -- remove history.
    if old.status <> 'draft' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    perform period_posting_fence(old.org_id, old.period_id, old.book_id);
    -- G5 (0338, restored in 0400): the delete fence is soft-close-aware
    -- like its sibling update branches. period_module_is_closed is true
    -- only for state = 'closed', so it let soft_closed deletes through,
    -- contradicting 0246's rule that a soft close fences posting the same
    -- way a hard close does.
    if period_module_blocks_write(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
      raise exception 'period is closed for GL posting';
    end if;
    return old;
  end if;

  -- Branch: posted-immutability (append-only: the only exit from posted is
  -- the evidenced reversal below; the amend same-status replay is gone by
  -- design and intentionally has no branch). The refusal names the remedy,
  -- which exists: corrections append a reversal through the ledger API
  -- (postEntry + markEntryReversed).
  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable: corrections append a reversal through the ledger API instead of editing history', old.id;
  end if;
  -- A posted entry may only leave posted status through controlled reversal
  -- (posted -> reversed). Any other regression — in particular posted ->
  -- draft, which would silently suppress posted history from every
  -- posted-only reader — raises here. No product flow writes posted -> draft.
  if old.status = 'posted' and new.status <> 'reversed' then
    raise exception 'journal entry % is posted and can only be reversed, not set to %', old.id, new.status;
  end if;
  -- Branch: reversal-evidence (0166, restored in 0400). posted -> reversed
  -- retires history, so the economics must already be offset: no economic
  -- header change may accompany the flip (only the lifecycle stamp and
  -- row-audit columns may differ), and a posted mirror reversal must exist
  -- in the same org and book referencing this entry. Existence, not
  -- uniqueness: reversal of a reversal and re-correction generations stay
  -- legal.
  if old.status = 'posted' and new.status = 'reversed' then
    if to_jsonb(old) - 'status' - 'updated_at' - 'updated_by' - 'posted_at'
       is distinct from
       to_jsonb(new) - 'status' - 'updated_at' - 'updated_by' - 'posted_at' then
      raise exception 'journal entry % is posted and can only be reversed without other changes', old.id;
    end if;
    if not exists (
      select 1
        from journal_entries reversal
       where reversal.org_id = old.org_id
         and reversal.book_id = old.book_id
         and reversal.reverses_entry_id = old.id
         and reversal.status = 'posted'
         and public.openbooks_reversal_mirrors(old.org_id, old.id, reversal.id)
    ) then
      raise exception 'journal entry % cannot be reversed without a posted mirror reversal in the same book', old.id;
    end if;
    return new;
  end if;
  -- Branch: reversed-immutable.
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;

  -- Branch: draft-post (f2/0168 owns the source-module recheck inside this block).
  if old.status = 'draft' and new.status = 'posted' then
    perform period_posting_fence(new.org_id, new.period_id, new.book_id);
    if period_module_blocks_write(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       or exists (
         select 1 from journal_lines l
          where l.entry_id = new.id
            and l.org_id = new.org_id
            and period_module_blocks_write(new.org_id, new.period_id, new.book_id,
              nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl',
              coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       ) then
      raise exception 'period is closed for GL posting';
    end if;
    -- Module recheck (0168, restored in 0405): the app boundary validates
    -- the source document's own close module, but a module-only close can
    -- commit between that check and this flip while the GL predicate above
    -- stays open. Re-derive the module from the sourced document kind and
    -- recheck it here, under the shared fence taken above, so the flip is
    -- atomic with the complete module set. Sourceless journals and unmapped
    -- kinds resolve to GL/null and skip: GL was already checked above.
    if new.source_document_id is not null then
      select public.document_close_module(d.kind) into v_module
        from public.documents d
       where d.id = new.source_document_id;
      if v_module is not null and v_module <> 'gl'
         and (period_module_blocks_write(new.org_id, new.period_id, new.book_id,
                nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, v_module,
                coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
              or exists (
                select 1 from journal_lines l
                 where l.entry_id = new.id
                   and l.org_id = new.org_id
                   and period_module_blocks_write(new.org_id, new.period_id, new.book_id,
                     nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, v_module,
                     coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
              )) then
        raise exception 'period is closed for % posting', upper(v_module);
      end if;
    end if;
    new.posted_at := now();
  end if;
  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- Assertion: the migrated body carries the restored branch and trusts no
-- raw GUC (check:rls-bypass-predicate).
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  def text := pg_catalog.pg_get_functiondef('public.je_guard()'::regprocedure);
BEGIN
  IF def NOT LIKE '%document_close_module%' THEN
    RAISE EXCEPTION '0405 assertion failed: public.je_guard() carries no source-module recheck.';
  END IF;
  IF def NOT LIKE '%v_module%' THEN
    RAISE EXCEPTION '0405 assertion failed: public.je_guard() lost its v_module declaration.';
  END IF;
  IF def LIKE '%app.bypass_rls%' THEN
    RAISE EXCEPTION '0405 assertion failed: public.je_guard() references app.bypass_rls outside public.app_bypass_rls_active().';
  END IF;
END
$assert$;
