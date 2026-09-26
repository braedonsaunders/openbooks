-- OpenBooks forward migration 0439_connector_replay_authorizations.
--
-- Posting into a closed period through the connector historical-replay door
-- used to rest on a transaction-local flag alone: whoever could set three
-- GUCs beside an active sync run could mirror upstream history with no
-- durable record of who allowed it, for which connector, for which periods,
-- or why. One row here is that durable grant: the authorizing controller,
-- the moment it was given, the connector it covers, the covered period
-- range, the reason, and the moment it stops working. postEntry refuses a
-- closed-period replay with no live row covering the period, and every
-- admitted replay carries its authorization id into its audit_log row, so
-- the grant and each use of it stay joined in evidence.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.connector_replay_authorizations (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  authorized_by uuid NOT NULL,
  authorized_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  period_from_id uuid NOT NULL,
  period_to_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT connector_replay_authorizations_pkey PRIMARY KEY (id),
  CONSTRAINT connector_replay_authorizations_reason_check
    CHECK (char_length(reason) BETWEEN 10 AND 1000),
  CONSTRAINT connector_replay_authorizations_expiry_check
    CHECK (expires_at > authorized_at)
);

ALTER TABLE public.connector_replay_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_replay_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.connector_replay_authorizations
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE INDEX IF NOT EXISTS connector_replay_authorizations_org_connection
  ON public.connector_replay_authorizations (org_id, connection_id);

COMMENT ON TABLE public.connector_replay_authorizations IS
  'Durable controller grants for connector historical replay into closed periods: who allowed which connector to mirror which period range, why, and until when. postEntry admits a closed-period replay only against a live row and cites it in the posting audit.';
COMMENT ON COLUMN public.connector_replay_authorizations.authorized_by IS
  'Controller who granted the replay window; the sync-run actor replays under it but never grants it.';
COMMENT ON COLUMN public.connector_replay_authorizations.period_from_id IS
  'One end of the covered accounting-period range; the ends are interchangeable, coverage is the date span between them.';
COMMENT ON COLUMN public.connector_replay_authorizations.period_to_id IS
  'The other end of the covered accounting-period range; the ends are interchangeable, coverage is the date span between them.';

-- ---------------------------------------------------------------------------
-- Closed-period connector replay inside the journal guard.
--
-- The application admits a closed-period connector replay only against a
-- live row above, but the journal guard knew nothing about that grant: its
-- draft -> posted fence refused the flip with "period is closed for GL
-- posting" even for an authorized replay. The admitted path now sets
-- openbooks.connector_replay_authorization to the granting row's id
-- (transaction-local, beside the flip), and the guard below re-validates
-- the named row — same organization, not expired, period range covers the
-- entry's period — before letting the flip through. Anything else still
-- raises the existing message. There is no session-level flag and no
-- bypass role: without a live named row the fence behaves exactly as
-- before.
-- ---------------------------------------------------------------------------

-- Preflight: the live body must still be the shape this change was authored
-- against (0405 body with the source-module recheck). A reshaped guard
-- blocks the upgrade by name instead of persisting a half-rewritten body.
DO $preflight$
DECLARE
  def text := pg_catalog.pg_get_functiondef('public.je_guard()'::regprocedure);
BEGIN
  IF def NOT LIKE '%v_module%' THEN
    RAISE EXCEPTION '0439 preflight: public.je_guard() has no source-module recheck; rebase this migration on its current body and re-run.';
  END IF;
  IF def LIKE '%openbooks_connector_replay_authorized%' THEN
    RAISE EXCEPTION '0439 preflight: public.je_guard() already honors connector replay authorizations; this migration is superseded, do not apply it.';
  END IF;
END
$preflight$;

-- True only for a live controller-recorded connector replay grant: the
-- named row belongs to the posting organization, its window is open now,
-- and the date span between its two period ends covers the entry's period.
-- Anything else — unknown id, another organization, an expired window, a
-- period outside the grant — is false, and the caller keeps refusing.
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
    RAISE EXCEPTION '0439 assertion failed: public.je_guard() carries no connector-replay-authorization branch.';
  END IF;
  IF def NOT LIKE '%openbooks_connector_replay_authorized%' THEN
    RAISE EXCEPTION '0439 assertion failed: public.je_guard() never calls openbooks_connector_replay_authorized().';
  END IF;
  IF authdef NOT LIKE '%expires_at > now()%' THEN
    RAISE EXCEPTION '0439 assertion failed: openbooks_connector_replay_authorized() lost its expiry check.';
  END IF;
  IF def LIKE '%app.bypass_rls%' THEN
    RAISE EXCEPTION '0439 assertion failed: public.je_guard() references app.bypass_rls outside public.app_bypass_rls_active().';
  END IF;
END
$assert$;
