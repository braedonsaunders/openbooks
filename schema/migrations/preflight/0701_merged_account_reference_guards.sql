-- Retain the published refusal and clone authority; extend only native guard coverage.
WITH refs AS (
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
   GROUP BY c.conrelid,cls.relname
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
)
SELECT '0701.guard_definition' AS code,'refuse' AS severity,
 'public.refuse_merged_account_reference()' AS subject,
 'The merged-account refusal function differs from its published definition.' AS detail,
 'Preserve the existing function and reconcile its published definition through the native runner before retrying.' AS remedy
 WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid='public.refuse_merged_account_reference()'::regprocedure
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
       AND NOT p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_catalog']::text[])
UNION ALL
SELECT '0701.trigger_definition','refuse','public.'||table_name,
 'The existing merged-account guard is not the native unconditional insert and column-update guard.',
 'Preserve the trigger and tenant history; reconcile its exact definition before extending account reference coverage.'
 FROM guards WHERE tgfoid IS DISTINCT FROM 'public.refuse_merged_account_reference()'::regprocedure::oid
      OR tgtype<>23 OR tgenabled NOT IN ('O','A') OR tgisinternal
      OR tgconstraint<>0 OR tgdeferrable OR tginitdeferred OR tgqual IS NOT NULL
      OR tgoldtable IS NOT NULL OR tgnewtable IS NOT NULL
      OR attribute_count=0 OR cardinality(guarded_columns)<>attribute_count
      OR cardinality(ARRAY(SELECT DISTINCT unnest(guarded_columns)))<>attribute_count
      OR tgnargs<>attribute_count OR tgargs IS DISTINCT FROM expected_args
      OR NOT (guarded_columns <@ columns);
