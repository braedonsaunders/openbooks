-- Refuse new or changed references to merged accounts on account foreign keys added since the guards were first attached.
-- The catalog-derived attachment is the same as the original guard installation: complete native guards are retained,
-- partial guards gain their new foreign key columns, and tables without one receive it. Existing references,
-- owned ledger history and registered native clones remain unchanged. Backfill: none.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);

DO $attach$
DECLARE v_ref record; v_guard record; v_enabled text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=to_regprocedure('public.refuse_merged_account_reference()')
       AND p.prosrc=$expected$
DECLARE
  v_column text;
  v_new text;
  v_survivor uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts
     WHERE org_id = NEW.org_id AND merged_into_id IS NOT NULL
  ) THEN
    RETURN NEW;
  END IF;
  IF public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  FOREACH v_column IN ARRAY TG_ARGV LOOP
    v_new := to_jsonb(NEW) ->> v_column;
    CONTINUE WHEN v_new IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> v_column) IS NOT DISTINCT FROM v_new;
    SELECT merged_into_id INTO v_survivor
      FROM public.accounts
     WHERE org_id = NEW.org_id AND id = v_new::uuid;
    IF v_survivor IS NOT NULL THEN
      RAISE EXCEPTION '%.% names account %, which was merged into account % — choose the surviving account', TG_TABLE_NAME, v_column, v_new, v_survivor
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$expected$
       AND l.lanname='plpgsql' AND p.prorettype='trigger'::regtype
       AND p.prokind='f' AND p.provolatile='v' AND NOT p.proisstrict AND NOT p.proleakproof
       AND NOT p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_catalog']::text[]) THEN
  RAISE EXCEPTION 'Preserve and reconcile the published merged-account refusal function before extending its coverage.' USING ERRCODE='23514';
 END IF;
 FOR v_ref IN
  SELECT c.conrelid AS relation_id, cls.relname AS table_name,
         array_agg(DISTINCT a.attname::text COLLATE "C" ORDER BY a.attname::text COLLATE "C") AS columns
    FROM pg_constraint c
    JOIN pg_class cls ON cls.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=cls.relnamespace AND n.nspname='public'
    JOIN LATERAL unnest(c.conkey) k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum AND NOT a.attisdropped
   WHERE c.contype='f' AND c.confrelid='public.accounts'::regclass
     AND a.attname<>'org_id'
     AND cls.relname NOT IN ('accounts','journal_lines','account_merges','account_localizations')
     AND EXISTS(SELECT 1 FROM pg_attribute o WHERE o.attrelid=c.conrelid AND o.attname='org_id' AND NOT o.attisdropped)
   GROUP BY c.conrelid,cls.relname ORDER BY cls.relname
 LOOP
  -- Serialize attachment with writes and concurrent trigger changes on this relation.
  EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE',v_ref.relation_id::regclass);
  WITH refs AS (
   SELECT v_ref.relation_id AS relation_id,v_ref.table_name AS table_name,v_ref.columns AS columns
  ), guards AS (
   SELECT r.*,t.oid AS trigger_id,t.tgfoid,t.tgtype,t.tgenabled,t.tgisinternal,
         t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgqual,t.tgoldtable,t.tgnewtable,
         t.tgnargs,t.tgargs,
         ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) k(attnum)
           JOIN pg_attribute a ON a.attrelid=r.relation_id AND a.attnum=k.attnum AND NOT a.attisdropped
           ORDER BY a.attname::text COLLATE "C") AS guarded_columns,
         cardinality(t.tgattr::smallint[]) AS attribute_count,
         (SELECT decode(string_agg(encode(convert_to(a.attname::text,'UTF8'),'hex')||'00','' ORDER BY a.attname::text COLLATE "C"),'hex')
            FROM unnest(t.tgattr::smallint[]) k(attnum)
            JOIN pg_attribute a ON a.attrelid=r.relation_id AND a.attnum=k.attnum AND NOT a.attisdropped) AS expected_args
    FROM refs r JOIN pg_trigger t ON t.tgrelid=r.relation_id
     AND t.tgname=left(r.table_name,40)||'_merged_account_guard'
  ) SELECT * INTO v_guard FROM guards;
  IF FOUND THEN
   IF v_guard.tgfoid IS DISTINCT FROM to_regprocedure('public.refuse_merged_account_reference()')::oid
      OR v_guard.tgtype<>23 OR v_guard.tgenabled NOT IN ('O','A') OR v_guard.tgisinternal
      OR v_guard.tgconstraint<>0 OR v_guard.tgdeferrable OR v_guard.tginitdeferred OR v_guard.tgqual IS NOT NULL
      OR v_guard.tgoldtable IS NOT NULL OR v_guard.tgnewtable IS NOT NULL
      OR v_guard.attribute_count=0 OR cardinality(v_guard.guarded_columns)<>v_guard.attribute_count
      OR cardinality(ARRAY(SELECT DISTINCT unnest(v_guard.guarded_columns)))<>v_guard.attribute_count
      OR v_guard.tgnargs<>v_guard.attribute_count OR v_guard.tgargs IS DISTINCT FROM v_guard.expected_args
      OR NOT (v_guard.guarded_columns <@ v_guard.columns) THEN
    RAISE EXCEPTION 'Preserve and reconcile the unexpected merged-account guard on % before extending its coverage.',v_ref.relation_id::regclass USING ERRCODE='23514';
   END IF;
   CONTINUE WHEN v_guard.guarded_columns=v_ref.columns;
   v_enabled:=v_guard.tgenabled;
   EXECUTE format('DROP TRIGGER %I ON %s',left(v_ref.table_name,40)||'_merged_account_guard',v_ref.relation_id::regclass);
  ELSE
   v_enabled:='O';
  END IF;
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %s ON %s FOR EACH ROW EXECUTE FUNCTION public.refuse_merged_account_reference(%s)',
   left(v_ref.table_name,40)||'_merged_account_guard',
   (SELECT string_agg(format('%I',col),', ' ORDER BY col COLLATE "C") FROM unnest(v_ref.columns) col),
   v_ref.relation_id::regclass,
   (SELECT string_agg(quote_literal(col),', ' ORDER BY col COLLATE "C") FROM unnest(v_ref.columns) col));
  IF v_enabled='A' THEN
   EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I',v_ref.relation_id::regclass,left(v_ref.table_name,40)||'_merged_account_guard');
  END IF;
 END LOOP;
END;
$attach$;
