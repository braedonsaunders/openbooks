-- OpenBooks forward migration 0046_account_posting_classification_serialization.
BEGIN;

-- Account classification is part of every ledger line's durable meaning. A
-- line writer therefore takes the same row lock an account UPDATE must own,
-- before it decides whether the account accepts the line. Whichever writer
-- arrives second re-reads the first writer's committed classification/history.
CREATE OR REPLACE FUNCTION public.jl_check_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_summary boolean;
  v_active boolean;
  v_ccy text;
begin
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
  'openbooks:jl_check_account:v3 - locks the tenant-coherent account row before validating a direct journal-line write';

-- This is deliberately a storage boundary, not an API convention. UPDATE has
-- already locked OLD's account row before this BEFORE trigger runs. Because
-- jl_check_account holds that same lock through line commit, a racing account
-- edit wakes only after the first line is visible to this direct existence
-- check. Metadata edits do not fire the trigger and remain valid.
CREATE OR REPLACE FUNCTION public.account_posting_classification_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_has_lines boolean;
begin
  if new.type is not distinct from old.type
     and new.is_summary is not distinct from old.is_summary then
    return new;
  end if;

  select exists (
    select 1
      from journal_lines
     where org_id = old.org_id
       and account_id = old.id
  ) into v_has_lines;

  if not v_has_lines then
    return new;
  end if;

  if new.type is distinct from old.type then
    raise exception 'account % type cannot change after journal lines exist', old.id
      using errcode = '23514', constraint = 'accounts_type_has_transactions';
  end if;

  if new.is_summary is distinct from old.is_summary then
    raise exception 'account % summary classification cannot change after journal lines exist', old.id
      using errcode = '23514', constraint = 'accounts_summary_has_transactions';
  end if;

  return new;
end $$;

COMMENT ON FUNCTION public.account_posting_classification_guard() IS
  'openbooks:account_posting_classification_guard:v1 - prevents direct type/summary reclassification after ledger history exists';

DROP TRIGGER IF EXISTS account_posting_classification_guard ON public.accounts;
CREATE TRIGGER account_posting_classification_guard
  BEFORE UPDATE OF type, is_summary ON public.accounts
  FOR EACH ROW
  WHEN (old.type IS DISTINCT FROM new.type OR old.is_summary IS DISTINCT FROM new.is_summary)
  EXECUTE FUNCTION public.account_posting_classification_guard();

COMMENT ON TRIGGER account_posting_classification_guard ON public.accounts IS
  'openbooks:account_posting_classification_guard:v1 - serializes classification edits with direct journal-line writes';

COMMIT;
