-- OpenBooks forward migration 0236_jl_check_account_evidence_stamp.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Live defect (Rassaun NetSuite incremental sync, failing since 2026-09-20):
-- the connector's cleared-date mirror stamps source_cleared_date /
-- source_cleared_connector on posted lines, and jl_check_account() refused
-- the stamp with 'account % is inactive' when the line's account had been
-- deactivated after posting. The refusal is correct for a POSTING but wrong
-- for an evidence stamp: the line was legally posted when the account was
-- active, and stamping cleared evidence changes no posting-relevant field
-- (not the account, not the amount, not the currency, not the entry). The
-- mirror runs inside one transaction, so a single deactivated account failed
-- the entire incremental run and all mirroring stopped.
--
-- The sibling guard already draws this line. jl_guard() (0158, kept in
-- 0159/0165) carves exactly reconciled_at, reconciliation_id,
-- source_cleared_date and source_cleared_connector out of its immutability
-- comparison and then admits only an append-only stamp. jl_check_account()
-- had no such carve-out, so the two guards disagreed about whether an
-- evidence-only stamp is a posting.
--
-- This migration re-creates jl_check_account() as the 0046 body plus one
-- early return: on UPDATE, when every non-evidence column is byte-identical
-- under the SAME four-column set jl_guard uses, the row is returned without
-- re-applying the posting checks. Append-only legality of the stamp itself
-- remains jl_guard's job and is untouched. Every other case keeps the full
-- checks: inserts to inactive accounts, updates touching amount/account/
-- currency on lines of inactive accounts, summary accounts, and
-- currency-restricted accounts are all still refused. No data is touched.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.jl_check_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_summary boolean;
  v_active boolean;
  v_ccy text;
begin
  -- Evidence-only stamps (0236) are not postings. The line satisfied the
  -- posting rules below when it was posted; recording cleared/reconciled
  -- evidence changes no posting-relevant field, so the question is not
  -- re-opened. The column set matches jl_guard() exactly: any UPDATE that
  -- touches anything else falls through to the full checks. Whether the
  -- stamp itself is a legal append-only transition stays jl_guard's call.
  if tg_op = 'UPDATE'
     and to_jsonb(new) - 'reconciled_at' - 'reconciliation_id' - 'source_cleared_date' - 'source_cleared_connector'
       = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id' - 'source_cleared_date' - 'source_cleared_connector'
  then
    return new;
  end if;
  select is_summary, is_active, currency_restriction
    into v_summary, v_active, v_ccy
   from accounts
   where id = new.account_id and org_id = new.org_id
     for share;
  if not found then
    raise exception 'account % does not exist in organization %', new.account_id, new.org_id
      using errcode = '23503';
  end if;
  if v_summary then
    raise exception 'account % is a summary account and cannot be posted to', new.account_id;
  end if;
  if not v_active and coalesce(current_setting('openbooks.migration', true), 'off') <> 'on' then
    raise exception 'account % is inactive', new.account_id;
  end if;
  if v_ccy is not null and new.currency <> v_ccy then
    raise exception 'account % only accepts % postings', new.account_id, v_ccy;
  end if;
  return new;
end $$;

COMMENT ON FUNCTION public.jl_check_account() IS
  'openbooks:jl_check_account:v4 - locks the tenant-coherent account row before validating a direct journal-line write; evidence-only stamps (0236) are not re-validated as postings';
