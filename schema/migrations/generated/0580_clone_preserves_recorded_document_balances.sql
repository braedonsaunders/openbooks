-- Preserve recorded document balances and revisions while copying their exact
-- journal and settlement history. Ordinary inserts, amendments and reversals
-- continue to refresh the balance from current ledger evidence.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- This predicate grants no authority. Both the parent and its inserted child
-- must match a registered sandbox's recorded source under native clone scope.
-- The parent entry and line keys bound the lookup before rebased identity and
-- every stored child column are compared, including currency and timestamps.
CREATE FUNCTION public.document_balance_clone_child_matches(
 parent public.documents, relation regclass, candidate jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_catalog AS $function$
DECLARE target record; source_entry uuid; original jsonb; expected jsonb;
 column_row record; policy_transform text; source_table_name text;
BEGIN
 IF NOT public.openbooks_clone_authority() OR relation NOT IN (
  'public.journal_lines'::regclass,'public.applications'::regclass)
  OR (parent).org_id IS DISTINCT FROM (candidate->>'org_id')::uuid
  OR NOT public.sales_document_clone_matches(parent) THEN RETURN false; END IF;
 SELECT o.id,o.sandbox_of,o.sandbox_seed,s.masked INTO target FROM public.orgs o
 JOIN public.sandboxes s ON s.org_id=o.id AND s.production_org_id=o.sandbox_of
 JOIN public.orgs source ON source.id=o.sandbox_of
 WHERE o.id=(parent).org_id AND o.env_kind='sandbox' AND o.sandbox_seed IS NOT NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT d.posted_entry_id INTO source_entry FROM public.documents d
 WHERE d.org_id=target.sandbox_of AND d.kind=(parent).kind
  AND d.document_number=(parent).document_number
  AND public.ob_rebase(d.id,target.sandbox_seed)=(parent).id;
 IF source_entry IS NULL THEN RETURN false; END IF;
 IF relation='public.journal_lines'::regclass THEN
  source_table_name:='journal_lines';
  SELECT to_jsonb(l) INTO original FROM public.journal_lines l
  WHERE l.org_id=target.sandbox_of AND l.entry_id=source_entry
   AND l.line_number=(candidate->>'line_number')::integer
   AND public.ob_rebase(l.id,target.sandbox_seed)=(candidate->>'id')::uuid;
 ELSE
  source_table_name:='applications';
  SELECT to_jsonb(a) INTO original FROM public.applications a
  WHERE a.org_id=target.sandbox_of
   AND (a.from_line_id IN (SELECT l.id FROM public.journal_lines l WHERE l.org_id=target.sandbox_of AND l.entry_id=source_entry)
     OR a.to_line_id IN (SELECT l.id FROM public.journal_lines l WHERE l.org_id=target.sandbox_of AND l.entry_id=source_entry))
   AND public.ob_rebase(a.id,target.sandbox_seed)=(candidate->>'id')::uuid;
 END IF;
 IF original IS NULL THEN RETURN false; END IF;
 expected:=original;
 FOR column_row IN SELECT attname,atttypid,attnotnull FROM pg_catalog.pg_attribute
  WHERE attrelid=relation AND attnum>0 AND NOT attisdropped LOOP
  IF column_row.attname='org_id' THEN
   expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(target.id));
  ELSIF column_row.atttypid='uuid'::regtype
   AND (column_row.attname='id' OR right(column_row.attname,3)='_id')
   AND jsonb_typeof(original->column_row.attname)='string' THEN
   expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(public.ob_rebase((original->>column_row.attname)::uuid,target.sandbox_seed)));
  END IF;
  -- Masking may remove free-form text and custom payloads, never financial
  -- values, dates or identities. Custom JSON is removed by default in masked
  -- copies; a declared value-removing policy must produce the same result.
  IF target.masked AND column_row.attname IN ('memo','custom') THEN
   SELECT p.transform INTO policy_transform FROM public.masking_policies p
   WHERE p.org_id=target.sandbox_of AND p.table_name=source_table_name
    AND p.column_name=column_row.attname AND p.is_active;
   IF column_row.attname='custom' AND policy_transform IS NULL THEN
    expected:=jsonb_set(expected,ARRAY[column_row.attname],'{}'::jsonb);
   ELSIF policy_transform='null_out' THEN
    expected:=jsonb_set(expected,ARRAY[column_row.attname],
     CASE WHEN column_row.attnotnull AND column_row.atttypid='jsonb'::regtype THEN '{}'::jsonb ELSE 'null'::jsonb END);
   ELSIF policy_transform='redact' AND original->column_row.attname<>'null'::jsonb THEN
    expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb('REDACTED'::text));
   ELSIF policy_transform='hash' AND original->column_row.attname<>'null'::jsonb THEN
    expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(md5(original->>column_row.attname)));
   END IF;
  END IF;
 END LOOP;
 RETURN candidate=expected;
END $function$;

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
      if tg_op='INSERT' and exists (
        select 1 from public.documents d where d.id=v_doc
         and public.document_balance_clone_child_matches(d,TG_RELID,to_jsonb(NEW))
      ) then continue; end if;
      perform public.recompute_document_open_balance(v_doc);
    end loop;
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;


CREATE OR REPLACE FUNCTION public.trg_application_open_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare v_doc uuid;
begin
  if openbooks_sandbox_wipe_allowed(
       case when tg_op = 'DELETE' then old.org_id else new.org_id end
     ) then
    return null;
  end if;
  for v_doc in
    select distinct d.id
      from documents d
      join journal_lines jl on jl.entry_id = d.posted_entry_id
     where jl.is_open_item
       and jl.id in (coalesce(new.to_line_id, old.to_line_id),
                     coalesce(new.from_line_id, old.from_line_id))
  loop
    if tg_op='INSERT' and exists (
      select 1 from public.documents d where d.id=v_doc
       and public.document_balance_clone_child_matches(d,TG_RELID,to_jsonb(NEW))
    ) then continue; end if;
    perform recompute_document_open_balance(v_doc);
  end loop;
  return null;
end $$;


