-- OpenBooks forward migration 0358_ledger_cache_triggers_cover_trusted_amend.
-- Keep derived ledger caches synchronized when trusted amendments move or
-- change the transaction-currency representation of journal lines.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.trg_journal_line_open_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_entries uuid[];
  v_entry uuid;
  v_doc uuid;
  v_org uuid;
begin
  if tg_op = 'DELETE' then
    v_entries := array[old.entry_id];
    v_org := old.org_id;
  elsif tg_op = 'INSERT' then
    v_entries := array[new.entry_id];
    v_org := new.org_id;
  elsif new.entry_id is distinct from old.entry_id
     or new.account_id is distinct from old.account_id
     or new.amount is distinct from old.amount
     or new.txn_amount is distinct from old.txn_amount
     or new.currency is distinct from old.currency
     or new.is_open_item is distinct from old.is_open_item then
    v_entries := array[old.entry_id, new.entry_id];
    v_org := new.org_id;
  else
    return new;
  end if;
  for v_entry in select distinct e from unnest(v_entries) as e loop
    for v_doc in select d.id from public.documents d
                  where d.org_id = v_org and d.posted_entry_id = v_entry loop
      perform public.recompute_document_open_balance(v_doc);
    end loop;
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

DROP TRIGGER IF EXISTS journal_line_open_balance ON public.journal_lines;
CREATE TRIGGER journal_line_open_balance AFTER INSERT OR DELETE OR UPDATE OF entry_id, account_id, amount, txn_amount, currency, is_open_item ON public.journal_lines
FOR EACH ROW EXECUTE FUNCTION public.trg_journal_line_open_balance();

DROP TRIGGER IF EXISTS party_payment_stats_date ON public.journal_lines;
CREATE TRIGGER party_payment_stats_date AFTER UPDATE OF entry_id, posting_date ON public.journal_lines
FOR EACH ROW WHEN (old.posting_date IS DISTINCT FROM new.posting_date)
EXECUTE FUNCTION public.trg_party_payment_stats_date();
