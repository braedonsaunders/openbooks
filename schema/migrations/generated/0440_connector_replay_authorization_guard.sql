-- OpenBooks forward migration 0440_connector_replay_authorization_guard.
--
-- Closed-period connector replay requires a live durable controller grant.
-- The 0439 table records who authorized the connector, the covered period
-- range, the reason, and the expiration. This migration checks that grant at
-- the journal guard as well as at the posting boundary, so a transaction-local
-- authorization id cannot open the closed-period fence by itself.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The replay predicate may be absent or already installed with these exact
-- bytes. A differing definition is an unknown policy and must be reviewed
-- before CREATE OR REPLACE can replace it. The guard may be the 0405
-- source-module-aware body or the replay-aware body from this migration.
DO $preflight$
DECLARE
  guard_source text;
  authorization_source text;
  guard_digest text;
BEGIN
  SELECT p.prosrc INTO guard_source
    FROM pg_catalog.pg_proc p
   WHERE p.oid = pg_catalog.to_regprocedure('public.je_guard()');
  IF guard_source IS NULL THEN
    RAISE EXCEPTION '0440 preflight: public.je_guard() is missing; restore its 0405 source-module-aware body before applying.';
  END IF;
  guard_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(guard_source, 'UTF8')), 'hex');
  IF guard_digest NOT IN (
    'a37008b2002f80373c69a0a4f1c1343845488cdf4c3511f00f749b0d2aa22ac3',
    'b04c5bd00429a773ddd89092376fd0be32740dcb545515c3848b70edd73e6778'
  ) THEN
    RAISE EXCEPTION '0440 preflight: public.je_guard() has unrecognized installed body digest %; review the live guard before applying.', guard_digest;
  END IF;

  SELECT p.prosrc INTO authorization_source
    FROM pg_catalog.pg_proc p
   WHERE p.oid = pg_catalog.to_regprocedure(
     'public.openbooks_connector_replay_authorized(uuid,uuid,uuid)'
   );
  IF authorization_source IS NOT NULL
     AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(authorization_source, 'UTF8')), 'hex')
       <> '30e83349531781e826cce792fa54a49f828b0d3667655870ecc11565f16653c3' THEN
    RAISE EXCEPTION '0440 preflight: public.openbooks_connector_replay_authorized() has a different body; review the live predicate before applying.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.openbooks_connector_replay_authorized(
  p_org uuid,
  p_authorization uuid,
  p_period uuid
) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_catalog
AS $$
  select exists (
    select 1
      from connector_replay_authorizations auth
      join accounting_periods from_period
        on from_period.id = auth.period_from_id
       and from_period.org_id = auth.org_id
      join accounting_periods to_period
        on to_period.id = auth.period_to_id
       and to_period.org_id = auth.org_id
      join accounting_periods target
        on target.id = p_period
       and target.org_id = p_org
     where auth.id = p_authorization
       and auth.org_id = p_org
       and auth.authorized_at <= now()
       and auth.expires_at > now()
       and target.starts_on >= least(from_period.starts_on, to_period.starts_on)
       and target.ends_on <= greatest(from_period.ends_on, to_period.ends_on)
  )
$$;

COMMENT ON FUNCTION public.openbooks_connector_replay_authorized(uuid, uuid, uuid) IS
  'Live-grant check for closed-period connector replay: the named connector_replay_authorizations row belongs to the posting organization, its window is open, and its period range covers the entry period. Fail-closed: anything else is false.';

CREATE OR REPLACE FUNCTION public.je_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_module text;
  v_replay_auth uuid;
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
      -- Branch: connector-replay-authorization (0439 admits a live durable
      -- grant through the closed-period fence). The application admits a
      -- closed-period connector replay only against a controller-recorded
      -- connector_replay_authorizations row covering the period, and names
      -- that row in openbooks.connector_replay_authorization
      -- (transaction-local) beside the flip. The named row is re-validated
      -- here — same organization, window open, period range covers this
      -- entry's period — so the durable grant opens the fence, never the
      -- flag alone. Anything else still raises below.
      begin
        v_replay_auth := nullif(current_setting('openbooks.connector_replay_authorization', true), '')::uuid;
      exception when invalid_text_representation then
        v_replay_auth := null;
      end;
      if not public.openbooks_connector_replay_authorized(new.org_id, v_replay_auth, new.period_id) then
        raise exception 'period is closed for GL posting';
      end if;
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
-- Assertion: the migrated body carries the replay-authorization branch and
-- trusts no raw GUC (check:rls-bypass-predicate).
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  def text := pg_catalog.pg_get_functiondef('public.je_guard()'::regprocedure);
  authdef text := pg_catalog.pg_get_functiondef('public.openbooks_connector_replay_authorized(uuid, uuid, uuid)'::regprocedure);
BEGIN
  IF def NOT LIKE '%Branch: connector-replay-authorization%' THEN
    RAISE EXCEPTION '0440 assertion failed: public.je_guard() carries no connector-replay-authorization branch.';
  END IF;
  IF def NOT LIKE '%openbooks_connector_replay_authorized%' THEN
    RAISE EXCEPTION '0440 assertion failed: public.je_guard() never calls openbooks_connector_replay_authorized().';
  END IF;
  IF authdef NOT LIKE '%expires_at > now()%' THEN
    RAISE EXCEPTION '0440 assertion failed: openbooks_connector_replay_authorized() lost its expiry check.';
  END IF;
  IF def LIKE '%app.bypass_rls%' THEN
    RAISE EXCEPTION '0440 assertion failed: public.je_guard() references app.bypass_rls outside public.app_bypass_rls_active().';
  END IF;
END
$assert$;
