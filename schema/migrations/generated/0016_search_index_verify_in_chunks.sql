-- Audit the search index in bounded chunks so the verifier runs on organizations of any size.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- The verifier compared every document's expected rows with the stored rows
-- in one statement, whose sort spills past the temporary-file limit on an
-- organization with millions of documents. It now compares two thousand
-- documents or entries at a time, the same chunking the rebuild uses, and
-- reports the same differences.
CREATE OR REPLACE FUNCTION public.openbooks_search_index_verify(p_org uuid) RETURNS TABLE(relation text, record_id uuid, detail text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_ids uuid[];
begin
  for v_ids in
    select array_agg(c.id) from (
      select d.id, (row_number() over (order by d.id) - 1) / 2000 as chunk
        from public.documents d where d.org_id = p_org
    ) c group by c.chunk
  loop
    return query
    with expected as (
      select t.document_id, t.term, t.kind, t.subsidiary_id, t.sort_at
        from public.openbooks_search_document_terms_for(p_org, v_ids) t
    ), stored as (
      select s.document_id, s.term, s.kind, s.subsidiary_id, s.sort_at
        from public.document_search_terms s where s.org_id = p_org and s.document_id = any(v_ids)
    )
    select 'document_search_terms', x.document_id, 'missing term ' || x.term
      from (select * from expected except select * from stored) x
    union all
    select 'document_search_terms', x.document_id, 'stale term ' || x.term
      from (select * from stored except select * from expected) x;

    return query
    with expected as (
      select a.document_id, a.cents, a.source, a.kind, a.subsidiary_id, a.sort_at
        from public.openbooks_search_document_amounts_for(p_org, v_ids) a
    ), stored as (
      select s.document_id, s.cents, s.source, s.kind, s.subsidiary_id, s.sort_at
        from public.document_search_amounts s where s.org_id = p_org and s.document_id = any(v_ids)
    )
    select 'document_search_amounts', x.document_id, 'missing amount ' || x.source || ' ' || x.cents
      from (select * from expected except select * from stored) x
    union all
    select 'document_search_amounts', x.document_id, 'stale amount ' || x.source || ' ' || x.cents
      from (select * from stored except select * from expected) x;
  end loop;

  -- Entries with no lines are covered too: their stored rows, if any, are stale.
  for v_ids in
    select array_agg(c.id) from (
      select e.id, (row_number() over (order by e.id) - 1) / 2000 as chunk
        from public.journal_entries e where e.org_id = p_org
    ) c group by c.chunk
  loop
    return query
    with expected as (
      select a.entry_id, a.subsidiary_id, a.cents, a.sort_at
        from public.openbooks_search_journal_amounts_for(p_org, v_ids) a
    ), stored as (
      select s.entry_id, s.subsidiary_id, s.cents, s.sort_at
        from public.journal_search_amounts s where s.org_id = p_org and s.entry_id = any(v_ids)
    )
    select 'journal_search_amounts', x.entry_id, 'missing amount ' || x.subsidiary_id || ' ' || x.cents
      from (select * from expected except select * from stored) x
    union all
    select 'journal_search_amounts', x.entry_id, 'stale amount ' || x.subsidiary_id || ' ' || x.cents
      from (select * from stored except select * from expected) x;
  end loop;

  -- Rows whose document or entry no longer exists.
  return query
  select 'document_search_terms', s.document_id, 'orphaned term ' || s.term
    from public.document_search_terms s
   where s.org_id = p_org and not exists (select 1 from public.documents d where d.org_id = p_org and d.id = s.document_id);
  return query
  select 'document_search_amounts', s.document_id, 'orphaned amount ' || s.source || ' ' || s.cents
    from public.document_search_amounts s
   where s.org_id = p_org and not exists (select 1 from public.documents d where d.org_id = p_org and d.id = s.document_id);
  return query
  select 'journal_search_amounts', s.entry_id, 'orphaned amount ' || s.subsidiary_id || ' ' || s.cents
    from public.journal_search_amounts s
   where s.org_id = p_org and not exists (select 1 from public.journal_entries e where e.org_id = p_org and e.id = s.entry_id);
end
$$;
