-- OpenBooks forward migration 0246_soft_close_posting_fence.
--
-- Soft-close is a first-class Setup action and the Xero PeriodLockDate
-- mapping. It must fence posting the same way a hard close does. The
-- Postgres twin of periodLockBlocksPosting is period_module_blocks_write;
-- both ignored soft_closed. Tax filing stays closed-only
-- (period_module_is_closed / an explicit closed state).

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.period_module_blocks_write(
  p_org uuid,
  p_period uuid,
  p_book uuid,
  p_subsidiary uuid,
  p_module text,
  p_allow_imported boolean
) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_catalog
AS $$
  select case
    when p_allow_imported
      and connector_historical_replay_authorized(p_org)
      then false
    else coalesce(
      (select case
         when p_allow_imported and reason = 'close.importedPeriodLockReason' then false
         when state = 'closed' then true
         when state = 'soft_closed' then true
         when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
         else false
       end
         from period_locks
        where org_id = p_org and period_id = p_period and book_id = p_book
          and subsidiary_id = p_subsidiary and module = p_module),
      (select case
         when p_allow_imported and reason = 'close.importedPeriodLockReason' then false
         when state = 'closed' then true
         when state = 'soft_closed' then true
         when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
         else false
       end
         from period_locks
        where org_id = p_org and period_id = p_period and book_id = p_book
          and subsidiary_id is null and module = p_module),
      false
    )
  end
$$;

COMMENT ON FUNCTION public.period_module_blocks_write(
  uuid, uuid, uuid, uuid, text, boolean
) IS
  'Blocks soft-closed and closed-period writes except source-owned imported locks or a database-authenticated connector replay; never changes the lock itself.';
