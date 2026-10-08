-- Bound FX residual checks to the affected entry identities. The translation
-- formula, subsidiary grouping, duplicate-input multiplicity and refusal
-- remedies are unchanged; no retained journal rows are rewritten.
SET statement_timeout = 0;
SET lock_timeout = '10s';
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.journal_lines_check_fx_residual_entries(p_entry_ids uuid[], p_new_posting boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
  v_bad_org uuid;
  v_bad_entry uuid;
  v_bad_subsidiary uuid;
  v_bad_deviation numeric(19, 4);
  v_bad_lines integer;
  v_bad_bound numeric;
begin
  -- Membership bounds the ledger lookup before aggregation. Multiplicity
  -- retains the original result even when a caller repeats an entry ID.
  -- Drafts continue to post through the entry-level balance gate.
  with entry_counts as materialized (
    select entry_id,count(*) as repetitions
      from unnest(p_entry_ids) as touched(entry_id)
     group by entry_id
  )
  select l.org_id, l.entry_id, l.subsidiary_id,
         sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4)) * touched.repetitions),
         sum(touched.repetitions),sum(touched.repetitions) * 0.00005
    into v_bad_org, v_bad_entry, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
    from public.journal_entries e
    join public.journal_lines l on l.entry_id=e.id
    join entry_counts touched on touched.entry_id=e.id
   where e.id=any(p_entry_ids) and e.status is distinct from 'draft'
   group by l.org_id, l.entry_id, l.subsidiary_id
  having sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4)) * touched.repetitions) > sum(touched.repetitions) * 0.00005
   limit 1;
  if found and p_new_posting then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): nothing was posted; correct the line exchange rates or functional amounts so each amount is its transaction amount times its rate, then post again',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  elsif found then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): posted lines cannot be amended; correct through the ledger API by posting a reversal and reposting instead of editing history',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  end if;
end $$;
