-- Index document text and amounts for search with predicates that row-level security lets an index serve.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- Under the tenant policy only LEAKPROOF operators can become index
-- conditions. Pattern and similarity operators are not LEAKPROOF, so text
-- search over documents would read every row of the tenant; equality and
-- range comparisons on text and integers are. These derived tables carry
-- each document's searchable terms and amounts in that form: a word prefix is
-- a btree range on a "C"-collated term, and an amount is an integer number of
-- cents. Derived and never authored: triggers on documents, document_lines
-- and journal_lines maintain them, and openbooks_search_index_rebuild()
-- reproduces them from source rows. Each row repeats the document's kind,
-- subsidiary and creation time so a reader applies its kind allowlist and
-- subsidiary fence and orders newest first without visiting the document.

CREATE TABLE public.document_search_terms (
    org_id uuid NOT NULL,
    document_id uuid NOT NULL,
    term text COLLATE "C" NOT NULL,
    kind text NOT NULL,
    subsidiary_id uuid,
    sort_at timestamp with time zone NOT NULL
);

COMMENT ON TABLE public.document_search_terms IS 'Derived search index: the lowercased words and identifier parts of each document''s number, references, memo and line descriptions; maintained by openbooks_search_index_* triggers.';

CREATE TABLE public.document_search_amounts (
    org_id uuid NOT NULL,
    document_id uuid NOT NULL,
    cents bigint NOT NULL,
    source text NOT NULL,
    kind text NOT NULL,
    subsidiary_id uuid,
    sort_at timestamp with time zone NOT NULL,
    CONSTRAINT document_search_amounts_source_check CHECK (source = ANY (ARRAY['total'::text, 'lines'::text, 'open'::text, 'tax'::text, 'line'::text]))
);

COMMENT ON TABLE public.document_search_amounts IS 'Derived search index: each document''s total, positive line sum, open balance, tax and line amounts as absolute cents; maintained by openbooks_search_index_* triggers.';

CREATE TABLE public.journal_search_amounts (
    org_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    cents bigint NOT NULL,
    sort_at timestamp with time zone NOT NULL
);

COMMENT ON TABLE public.journal_search_amounts IS 'Derived search index: each journal entry''s line amounts as absolute cents, by the line''s subsidiary; maintained by openbooks_search_index_* triggers.';

ALTER TABLE public.document_search_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_search_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.document_search_terms
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.document_search_terms IS 'openbooks:org_isolation:v1';

ALTER TABLE public.document_search_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_search_amounts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.document_search_amounts
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.document_search_amounts IS 'openbooks:org_isolation:v1';

ALTER TABLE public.journal_search_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_search_amounts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.journal_search_amounts
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.journal_search_amounts IS 'openbooks:org_isolation:v1';

-- The terms of a text: its lowercased words of two or more characters (or
-- any word with a digit), each letter and digit run of a word that mixes
-- them (INV3668 also yields inv and 3668), and each zero-padded number
-- without its padding (0003668 also yields 3668).
CREATE FUNCTION public.openbooks_search_terms(p_text text) RETURNS SETOF text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  with words as (
    select w from regexp_split_to_table(lower(coalesce(p_text, '')), '[^[:alnum:]]+') w
     where w <> ''
  ), parts as (
    select w as term from words where length(w) >= 2 or w ~ '[[:digit:]]'
    union
    select r[1] from words, regexp_matches(w, '[[:alpha:]]+|[[:digit:]]+', 'g') r
     where w ~ '[[:alpha:]]' and w ~ '[[:digit:]]'
    union
    select ltrim(r[1], '0') from words, regexp_matches(w, '[[:digit:]]+', 'g') r
     where r[1] ~ '^0+[1-9]'
  )
  select left(term, 64) from parts where term <> ''
$$;

-- An amount as the absolute number of cents a search compares, rounded half
-- away from zero like the amounts it displays.
CREATE FUNCTION public.openbooks_search_cents(p_amount numeric) RETURNS bigint
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$ select round(abs(p_amount) * 100)::bigint $$;

-- The rows each table should hold for the given documents or entries. The
-- maintenance triggers, the rebuild and the verifier all read through these,
-- so there is one definition of what a record contributes.
CREATE FUNCTION public.openbooks_search_document_terms_for(p_org uuid, p_ids uuid[])
    RETURNS TABLE(org_id uuid, document_id uuid, term text, kind text, subsidiary_id uuid, sort_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select distinct d.org_id, d.id, t.term collate "C", d.kind, d.subsidiary_id, d.created_at
    from public.documents d
    cross join lateral (
      select public.openbooks_search_terms(concat_ws(' ', d.document_number, d.reference_number, d.external_ref, d.memo)) as term
      union
      select public.openbooks_search_terms(l.description)
        from public.document_lines l
       where l.org_id = d.org_id and l.document_id = d.id and l.description is not null
    ) t
   where d.org_id = p_org and d.id = any(p_ids)
$$;

CREATE FUNCTION public.openbooks_search_document_amounts_for(p_org uuid, p_ids uuid[])
    RETURNS TABLE(org_id uuid, document_id uuid, cents bigint, source text, kind text, subsidiary_id uuid, sort_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select distinct d.org_id, d.id, a.cents, a.source, d.kind, d.subsidiary_id, d.created_at
    from public.documents d
    cross join lateral (
      select public.openbooks_search_cents(d.total) as cents, 'total' as source where d.total <> 0
      union all
      select public.openbooks_search_cents(d.open_balance), 'open' where coalesce(d.open_balance, 0) <> 0
      union all
      select public.openbooks_search_cents(d.tax_total), 'tax' where d.tax_total <> 0
      union all
      select public.openbooks_search_cents(sum(l.amount)), 'lines'
        from public.document_lines l
       where l.org_id = d.org_id and l.document_id = d.id and l.amount > 0
      having sum(l.amount) > 0
      union all
      select public.openbooks_search_cents(l.amount), 'line'
        from public.document_lines l
       where l.org_id = d.org_id and l.document_id = d.id and l.amount <> 0
    ) a
   where d.org_id = p_org and d.id = any(p_ids) and a.cents > 0
$$;

CREATE FUNCTION public.openbooks_search_journal_amounts_for(p_org uuid, p_ids uuid[])
    RETURNS TABLE(org_id uuid, entry_id uuid, subsidiary_id uuid, cents bigint, sort_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select distinct l.org_id, l.entry_id, l.subsidiary_id, public.openbooks_search_cents(l.amount), e.created_at
    from public.journal_lines l
    join public.journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
   where l.org_id = p_org and l.entry_id = any(p_ids) and l.amount <> 0
$$;

-- Re-derive the given documents' rows, writing only the difference: a memo
-- edit or a payment touches the rows it changes, not every row of the
-- document. The documents' rows are locked first, so concurrent writers to
-- one document re-derive it one after another and each sees the other's
-- committed rows.
CREATE FUNCTION public.openbooks_search_index_documents(p_org uuid, p_ids uuid[], p_terms boolean, p_amounts boolean) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_terms public.document_search_terms[];
  v_amounts public.document_search_amounts[];
begin
  perform 1 from public.documents d where d.org_id = p_org and d.id = any(p_ids) order by d.id for no key update;
  if p_terms then
    select coalesce(array_agg(row(t.*)::public.document_search_terms), '{}') into v_terms
      from public.openbooks_search_document_terms_for(p_org, p_ids) t;
    delete from public.document_search_terms s
     using (select x.document_id, x.term from (
              select c.document_id, c.term, c.kind, c.subsidiary_id, c.sort_at
                from public.document_search_terms c where c.org_id = p_org and c.document_id = any(p_ids)
              except
              select n.document_id, n.term, n.kind, n.subsidiary_id, n.sort_at from unnest(v_terms) n) x) stale
     where s.org_id = p_org and s.document_id = stale.document_id and s.term = stale.term;
    insert into public.document_search_terms (org_id, document_id, term, kind, subsidiary_id, sort_at)
    select p_org, x.document_id, x.term, x.kind, x.subsidiary_id, x.sort_at from (
      select n.document_id, n.term, n.kind, n.subsidiary_id, n.sort_at from unnest(v_terms) n
      except
      select c.document_id, c.term, c.kind, c.subsidiary_id, c.sort_at
        from public.document_search_terms c where c.org_id = p_org and c.document_id = any(p_ids)) x;
  end if;
  if p_amounts then
    select coalesce(array_agg(row(a.*)::public.document_search_amounts), '{}') into v_amounts
      from public.openbooks_search_document_amounts_for(p_org, p_ids) a;
    delete from public.document_search_amounts s
     using (select x.document_id, x.source, x.cents from (
              select c.document_id, c.cents, c.source, c.kind, c.subsidiary_id, c.sort_at
                from public.document_search_amounts c where c.org_id = p_org and c.document_id = any(p_ids)
              except
              select n.document_id, n.cents, n.source, n.kind, n.subsidiary_id, n.sort_at from unnest(v_amounts) n) x) stale
     where s.org_id = p_org and s.document_id = stale.document_id and s.source = stale.source and s.cents = stale.cents;
    insert into public.document_search_amounts (org_id, document_id, cents, source, kind, subsidiary_id, sort_at)
    select p_org, x.document_id, x.cents, x.source, x.kind, x.subsidiary_id, x.sort_at from (
      select n.document_id, n.cents, n.source, n.kind, n.subsidiary_id, n.sort_at from unnest(v_amounts) n
      except
      select c.document_id, c.cents, c.source, c.kind, c.subsidiary_id, c.sort_at
        from public.document_search_amounts c where c.org_id = p_org and c.document_id = any(p_ids)) x;
  end if;
end
$$;

CREATE FUNCTION public.openbooks_search_index_journal_entries(p_org uuid, p_ids uuid[]) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_amounts public.journal_search_amounts[];
begin
  perform 1 from public.journal_entries e where e.org_id = p_org and e.id = any(p_ids) order by e.id for no key update;
  select coalesce(array_agg(row(a.*)::public.journal_search_amounts), '{}') into v_amounts
    from public.openbooks_search_journal_amounts_for(p_org, p_ids) a;
  delete from public.journal_search_amounts s
   using (select x.entry_id, x.subsidiary_id, x.cents from (
            select c.entry_id, c.subsidiary_id, c.cents, c.sort_at
              from public.journal_search_amounts c where c.org_id = p_org and c.entry_id = any(p_ids)
            except
            select n.entry_id, n.subsidiary_id, n.cents, n.sort_at from unnest(v_amounts) n) x) stale
   where s.org_id = p_org and s.entry_id = stale.entry_id and s.subsidiary_id = stale.subsidiary_id and s.cents = stale.cents;
  insert into public.journal_search_amounts (org_id, entry_id, subsidiary_id, cents, sort_at)
  select p_org, x.entry_id, x.subsidiary_id, x.cents, x.sort_at from (
    select n.entry_id, n.subsidiary_id, n.cents, n.sort_at from unnest(v_amounts) n
    except
    select c.entry_id, c.subsidiary_id, c.cents, c.sort_at
      from public.journal_search_amounts c where c.org_id = p_org and c.entry_id = any(p_ids)) x;
end
$$;

-- Inserted documents and lines, one statement at a time: posting and imports
-- insert many rows per statement, and each document is derived once.
CREATE FUNCTION public.openbooks_search_index_document_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v record;
begin
  for v in select n.org_id, array_agg(n.id) as ids from inserted_documents n group by n.org_id loop
    perform public.openbooks_search_index_documents(v.org_id, v.ids, true, true);
  end loop;
  return null;
end
$$;

CREATE FUNCTION public.openbooks_search_index_document_line_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v record;
begin
  for v in select n.org_id, array_agg(distinct n.document_id) as ids from inserted_document_lines n group by n.org_id loop
    perform public.openbooks_search_index_documents(v.org_id, v.ids, true, true);
  end loop;
  return null;
end
$$;

CREATE FUNCTION public.openbooks_search_index_journal_line_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v record;
begin
  for v in select n.org_id, array_agg(distinct n.entry_id) as ids from inserted_journal_lines n group by n.org_id loop
    perform public.openbooks_search_index_journal_entries(v.org_id, v.ids);
  end loop;
  return null;
end
$$;

-- A changed document re-derives what the change reaches: its text, kind and
-- subsidiary reach every row, its amounts only the amount rows.
CREATE FUNCTION public.openbooks_search_index_document_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if (old.id, old.org_id) is distinct from (new.id, new.org_id) then
    delete from public.document_search_terms s where s.org_id = old.org_id and s.document_id = old.id;
    delete from public.document_search_amounts s where s.org_id = old.org_id and s.document_id = old.id;
  end if;
  perform public.openbooks_search_index_documents(new.org_id, array[new.id], tg_argv[0] = 'all', true);
  return null;
end
$$;

CREATE FUNCTION public.openbooks_search_index_document_line_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if (old.document_id, old.org_id) is distinct from (new.document_id, new.org_id) then
    perform public.openbooks_search_index_documents(old.org_id, array[old.document_id], true, true);
  end if;
  perform public.openbooks_search_index_documents(new.org_id, array[new.document_id],
    old.description is distinct from new.description or (old.document_id, old.org_id) is distinct from (new.document_id, new.org_id),
    old.amount is distinct from new.amount or (old.document_id, old.org_id) is distinct from (new.document_id, new.org_id));
  return null;
end
$$;

CREATE FUNCTION public.openbooks_search_index_journal_line_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if (old.entry_id, old.org_id) is distinct from (new.entry_id, new.org_id) then
    perform public.openbooks_search_index_journal_entries(old.org_id, array[old.entry_id]);
  end if;
  perform public.openbooks_search_index_journal_entries(new.org_id, array[new.entry_id]);
  return null;
end
$$;

-- Deleted documents and entries take their rows with them, whatever removes
-- them: a retirement or sandbox wipe deletes these rows too, and removing a
-- derived row is always sound.
CREATE FUNCTION public.openbooks_search_index_document_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v record;
begin
  for v in select o.org_id, array_agg(o.id) as ids from deleted_documents o group by o.org_id loop
    delete from public.document_search_terms s where s.org_id = v.org_id and s.document_id = any(v.ids);
    delete from public.document_search_amounts s where s.org_id = v.org_id and s.document_id = any(v.ids);
  end loop;
  return null;
end
$$;

CREATE FUNCTION public.openbooks_search_index_journal_entry_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v record;
begin
  for v in select o.org_id, array_agg(o.id) as ids from deleted_journal_entries o group by o.org_id loop
    delete from public.journal_search_amounts s where s.org_id = v.org_id and s.entry_id = any(v.ids);
  end loop;
  return null;
end
$$;

-- Deleted lines re-derive their document or entry. An organization being
-- retired or a sandbox being wiped is skipped: re-deriving would write into a
-- tenant that is going away, and the parent's own delete clears its rows.
CREATE FUNCTION public.openbooks_search_index_document_line_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v record;
begin
  for v in select o.org_id, array_agg(distinct o.document_id) as ids from deleted_document_lines o group by o.org_id loop
    if tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,
         (select to_jsonb(s) from deleted_document_lines s where s.org_id = v.org_id limit 1))
       or public.openbooks_sandbox_wipe_allowed(v.org_id) then
      continue;
    end if;
    perform public.openbooks_search_index_documents(v.org_id, v.ids, true, true);
  end loop;
  return null;
end
$$;

CREATE FUNCTION public.openbooks_search_index_journal_line_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v record;
begin
  for v in select o.org_id, array_agg(distinct o.entry_id) as ids from deleted_journal_lines o group by o.org_id loop
    if tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,
         (select to_jsonb(s) from deleted_journal_lines s where s.org_id = v.org_id limit 1))
       or public.openbooks_sandbox_wipe_allowed(v.org_id) then
      continue;
    end if;
    perform public.openbooks_search_index_journal_entries(v.org_id, v.ids);
  end loop;
  return null;
end
$$;

-- Repair and audit: recompute one organization's rows from source, and list
-- every row that differs from its source (empty when sound).
CREATE FUNCTION public.openbooks_search_index_rebuild(p_org uuid) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_ids uuid[];
  v_rows bigint := 0;
  v_count bigint;
begin
  delete from public.document_search_terms where org_id = p_org;
  delete from public.document_search_amounts where org_id = p_org;
  delete from public.journal_search_amounts where org_id = p_org;
  for v_ids in
    select array_agg(c.id) from (
      select d.id, (row_number() over (order by d.id) - 1) / 2000 as chunk
        from public.documents d where d.org_id = p_org
    ) c group by c.chunk
  loop
    insert into public.document_search_terms (org_id, document_id, term, kind, subsidiary_id, sort_at)
    select * from public.openbooks_search_document_terms_for(p_org, v_ids);
    get diagnostics v_count = row_count;
    v_rows := v_rows + v_count;
    insert into public.document_search_amounts (org_id, document_id, cents, source, kind, subsidiary_id, sort_at)
    select * from public.openbooks_search_document_amounts_for(p_org, v_ids);
    get diagnostics v_count = row_count;
    v_rows := v_rows + v_count;
  end loop;
  for v_ids in
    select array_agg(c.id) from (
      select e.id, (row_number() over (order by e.id) - 1) / 2000 as chunk
        from public.journal_entries e where e.org_id = p_org
    ) c group by c.chunk
  loop
    insert into public.journal_search_amounts (org_id, entry_id, subsidiary_id, cents, sort_at)
    select * from public.openbooks_search_journal_amounts_for(p_org, v_ids);
    get diagnostics v_count = row_count;
    v_rows := v_rows + v_count;
  end loop;
  return v_rows;
end
$$;

CREATE FUNCTION public.openbooks_search_index_verify(p_org uuid) RETURNS TABLE(relation text, record_id uuid, detail text)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  with documents as (
    select array_agg(d.id) as ids from public.documents d where d.org_id = p_org
  ), entries as (
    select array_agg(e.id) as ids from public.journal_entries e where e.org_id = p_org
  ), terms as (
    select coalesce(a.document_id, b.document_id) as record_id,
           coalesce(a.term, b.term) as term, a.document_id is null as extra
      from (select t.* from documents, public.openbooks_search_document_terms_for(p_org, documents.ids) t) a
      full join (select s.* from public.document_search_terms s where s.org_id = p_org) b
        on b.document_id = a.document_id and b.term = a.term
       and b.kind = a.kind and b.subsidiary_id is not distinct from a.subsidiary_id and b.sort_at = a.sort_at
     where a.document_id is null or b.document_id is null
  ), amounts as (
    select coalesce(a.document_id, b.document_id) as record_id,
           coalesce(a.source, b.source) || ' ' || coalesce(a.cents, b.cents) as amount, a.document_id is null as extra
      from (select t.* from documents, public.openbooks_search_document_amounts_for(p_org, documents.ids) t) a
      full join (select s.* from public.document_search_amounts s where s.org_id = p_org) b
        on b.document_id = a.document_id and b.source = a.source and b.cents = a.cents
       and b.kind = a.kind and b.subsidiary_id is not distinct from a.subsidiary_id and b.sort_at = a.sort_at
     where a.document_id is null or b.document_id is null
  ), journal as (
    select coalesce(a.entry_id, b.entry_id) as record_id,
           coalesce(a.subsidiary_id, b.subsidiary_id) || ' ' || coalesce(a.cents, b.cents) as amount, a.entry_id is null as extra
      from (select t.* from entries, public.openbooks_search_journal_amounts_for(p_org, entries.ids) t) a
      full join (select s.* from public.journal_search_amounts s where s.org_id = p_org) b
        on b.entry_id = a.entry_id and b.subsidiary_id = a.subsidiary_id and b.cents = a.cents and b.sort_at = a.sort_at
     where a.entry_id is null or b.entry_id is null
  )
  select 'document_search_terms', record_id, case when extra then 'stale term ' else 'missing term ' end || term from terms
  union all
  select 'document_search_amounts', record_id, case when extra then 'stale amount ' else 'missing amount ' end || amount from amounts
  union all
  select 'journal_search_amounts', record_id, case when extra then 'stale amount ' else 'missing amount ' end || amount from journal
$$;

-- Triggers before the backfill: creating them takes the write locks on the
-- source tables, so no write lands between the backfill's snapshot and their
-- activation.
CREATE TRIGGER search_index_document_insert
  AFTER INSERT ON public.documents REFERENCING NEW TABLE AS inserted_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_search_index_document_insert();
CREATE TRIGGER search_index_document_text
  AFTER UPDATE OF document_number, reference_number, external_ref, memo, kind, subsidiary_id, created_at, id, org_id ON public.documents
  FOR EACH ROW
  WHEN ((old.document_number, old.reference_number, old.external_ref, old.memo, old.kind, old.subsidiary_id, old.created_at, old.id, old.org_id)
        IS DISTINCT FROM (new.document_number, new.reference_number, new.external_ref, new.memo, new.kind, new.subsidiary_id, new.created_at, new.id, new.org_id))
  EXECUTE FUNCTION public.openbooks_search_index_document_update('all');
CREATE TRIGGER search_index_document_amounts
  AFTER UPDATE OF total, open_balance, tax_total ON public.documents
  FOR EACH ROW
  WHEN ((old.total, old.open_balance, old.tax_total) IS DISTINCT FROM (new.total, new.open_balance, new.tax_total))
  EXECUTE FUNCTION public.openbooks_search_index_document_update('amounts');
CREATE TRIGGER search_index_document_delete
  AFTER DELETE ON public.documents REFERENCING OLD TABLE AS deleted_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_search_index_document_delete();

CREATE TRIGGER search_index_document_line_insert
  AFTER INSERT ON public.document_lines REFERENCING NEW TABLE AS inserted_document_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_search_index_document_line_insert();
CREATE TRIGGER search_index_document_line_update
  AFTER UPDATE OF description, amount, document_id, org_id ON public.document_lines
  FOR EACH ROW
  WHEN ((old.description, old.amount, old.document_id, old.org_id) IS DISTINCT FROM (new.description, new.amount, new.document_id, new.org_id))
  EXECUTE FUNCTION public.openbooks_search_index_document_line_update();
CREATE TRIGGER search_index_document_line_delete
  AFTER DELETE ON public.document_lines REFERENCING OLD TABLE AS deleted_document_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_search_index_document_line_delete();

CREATE TRIGGER search_index_journal_entry_delete
  AFTER DELETE ON public.journal_entries REFERENCING OLD TABLE AS deleted_journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_search_index_journal_entry_delete();
CREATE TRIGGER search_index_journal_line_insert
  AFTER INSERT ON public.journal_lines REFERENCING NEW TABLE AS inserted_journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_search_index_journal_line_insert();
CREATE TRIGGER search_index_journal_line_update
  AFTER UPDATE OF amount, subsidiary_id, entry_id, org_id ON public.journal_lines
  FOR EACH ROW
  WHEN ((old.amount, old.subsidiary_id, old.entry_id, old.org_id) IS DISTINCT FROM (new.amount, new.subsidiary_id, new.entry_id, new.org_id))
  EXECUTE FUNCTION public.openbooks_search_index_journal_line_update();
CREATE TRIGGER search_index_journal_line_delete
  AFTER DELETE ON public.journal_lines REFERENCING OLD TABLE AS deleted_journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_search_index_journal_line_delete();

SELECT public.openbooks_search_index_rebuild(o.id) FROM public.orgs o;

-- Keys and indexes are built once over the filled tables rather than
-- maintained row by row during the fill, keeping the write locks short.
SET maintenance_work_mem = '256MB';
ALTER TABLE public.document_search_terms ADD CONSTRAINT document_search_terms_pkey PRIMARY KEY (org_id, document_id, term);
ALTER TABLE public.document_search_amounts ADD CONSTRAINT document_search_amounts_pkey PRIMARY KEY (org_id, document_id, source, cents);
ALTER TABLE public.journal_search_amounts ADD CONSTRAINT journal_search_amounts_pkey PRIMARY KEY (org_id, entry_id, subsidiary_id, cents);
-- A term (or term prefix) newest first; an amount (or amount range) newest
-- first. The included columns let the kind allowlist and subsidiary fence
-- filter inside the index.
CREATE INDEX document_search_terms_term ON public.document_search_terms USING btree (org_id, term, sort_at DESC, document_id) INCLUDE (kind, subsidiary_id);
CREATE INDEX document_search_amounts_cents ON public.document_search_amounts USING btree (org_id, cents, sort_at DESC, document_id) INCLUDE (kind, subsidiary_id, source);
CREATE INDEX journal_search_amounts_cents ON public.journal_search_amounts USING btree (org_id, cents, sort_at DESC, entry_id) INCLUDE (subsidiary_id);


CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.document_search_terms
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.document_search_amounts
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_search_amounts
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

ANALYZE public.document_search_terms;
ANALYZE public.document_search_amounts;
ANALYZE public.journal_search_amounts;

-- Expose the index through the governed query views like the other derived rollups.
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('document_search_terms', '0015_search_index'),
       ('document_search_amounts', '0015_search_index'),
       ('journal_search_amounts', '0015_search_index')
ON CONFLICT (relation) DO NOTHING;
SELECT public.openbooks_refresh_query_catalog();
