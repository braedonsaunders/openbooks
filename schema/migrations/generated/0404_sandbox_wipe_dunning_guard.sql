-- OpenBooks forward migration 0404_sandbox_wipe_dunning_guard.
--
-- SANDBOX-WIPE-DUNNING: migration 0294's dunning_log_guard refuses DELETE
-- unconditionally (except the bypass predicate), so wipeSandbox — the single
-- shared wipe behind sandbox refresh, reset and delete — dies on the first
-- dunning_log row of any sandbox that holds dunning delivery evidence. The
-- failed wipe marks the sandbox failed and strands its org behind
-- orgs_sandbox_of_fkey, so even a successful refresh cannot be torn down.
--
-- Every other wipe-facing DELETE guard routes its teardown exemption through
-- the canonical helper (0078, 0338 pattern): DELETE-only, sandbox-org-only,
-- transaction-local GUC. 0294 predates that pattern for this table and missed
-- it. This migration adds exactly that arm to dunning_log_guard, rebuilt
-- from the live 0402 body (predicate call kept verbatim — never a raw
-- app.bypass_rls read, which check:rls-bypass-predicate refuses).
--
-- Re-runnable: CREATE OR REPLACE converges, and both DO blocks pass on a
-- migrated catalog.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Preflight: the live body must still be the 0402 shape (predicate-guarded
-- bypass arm, unconditional DELETE refusal). A renamed or reshaped guard
-- blocks the upgrade by name instead of persisting a half-rewritten body.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  def text := pg_catalog.pg_get_functiondef('public.dunning_log_guard()'::regprocedure);
BEGIN
  IF def NOT LIKE '%public.app_bypass_rls_active()%' THEN
    RAISE EXCEPTION '0404 preflight: public.dunning_log_guard() no longer calls public.app_bypass_rls_active(); rebase this migration on its current body and re-run.';
  END IF;
  IF def LIKE '%app.bypass_rls%' THEN
    RAISE EXCEPTION '0404 preflight: public.dunning_log_guard() still references app.bypass_rls outside the predicate; rebase this migration on its current body and re-run.';
  END IF;
  IF def LIKE '%openbooks_sandbox_wipe_allowed%' THEN
    RAISE EXCEPTION '0404 preflight: public.dunning_log_guard() already names openbooks_sandbox_wipe_allowed; this migration is superseded, do not apply it.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.dunning_log_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if public.app_bypass_rls_active() then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if TG_OP = 'DELETE' then
    raise exception 'dunning_log is append-only: DELETE is refused; a rung''s lifecycle moves forward through staged/sent/failed/suppressed transitions only';
  end if;
  if TG_OP = 'INSERT' then
    return new;
  end if;
  if old.status = 'sent' or old.status = 'skipped' then
    raise exception 'dunning_log % rows are terminal delivery evidence and cannot be updated; failed and suppressed rows re-arm to staged, sent rows never move', old.status;
  end if;
  if old.status = 'staged' and new.status in ('sent', 'failed', 'suppressed') then
    return new;
  end if;
  if (old.status = 'failed' or old.status = 'suppressed') and new.status = 'staged' then
    return new;
  end if;
  raise exception 'dunning_log transition % to % is refused: the send attempt may move staged to sent/failed/suppressed, and the runner may re-arm failed/suppressed to staged', old.status, new.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Assertion: the migrated body keeps the predicate, carries the wipe
-- exemption, and trusts no raw GUC (check:rls-bypass-predicate).
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  def text := pg_catalog.pg_get_functiondef('public.dunning_log_guard()'::regprocedure);
BEGIN
  IF def NOT LIKE '%public.app_bypass_rls_active()%' THEN
    RAISE EXCEPTION '0404 assertion failed: public.dunning_log_guard() lost its public.app_bypass_rls_active() arm.';
  END IF;
  IF def NOT LIKE '%openbooks_sandbox_wipe_allowed%' THEN
    RAISE EXCEPTION '0404 assertion failed: public.dunning_log_guard() carries no openbooks_sandbox_wipe_allowed exemption.';
  END IF;
  IF def LIKE '%app.bypass_rls%' THEN
    RAISE EXCEPTION '0404 assertion failed: public.dunning_log_guard() references app.bypass_rls outside public.app_bypass_rls_active().';
  END IF;
END
$assert$;
