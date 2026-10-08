-- Share one journal-line aggregation between whole-entry and subsidiary
-- balances. Custom-segment balances remain independently enforced for the
-- affected organizations that configure them; no retained rows are changed.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.journal_lines_check_balanced_entries(p_entry_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_catalog AS $function$
DECLARE
  v_bad_entry uuid;
  v_bad_subsidiary uuid;
  v_bad_total numeric(19,4);
  v_whole_entry integer;
  v_bad_segment text;
  v_bad_value text;
BEGIN
  IF coalesce(cardinality(p_entry_ids),0)=0 THEN
    RETURN;
  END IF;

  -- GROUPING distinguishes the whole-entry subtotal from a subsidiary group,
  -- including any retained NULL subsidiary. Whole-entry refusals take priority
  -- across the complete set, just as when the two checks ran separately.
  SELECT e.id,l.subsidiary_id,sum(l.amount),grouping(l.subsidiary_id)
    INTO v_bad_entry,v_bad_subsidiary,v_bad_total,v_whole_entry
    FROM public.journal_entries e
    JOIN public.journal_lines l ON l.entry_id=e.id AND l.org_id=e.org_id
   WHERE e.id=ANY(p_entry_ids) AND e.status IS DISTINCT FROM 'draft'
   GROUP BY GROUPING SETS ((e.id),(e.id,l.subsidiary_id))
  HAVING sum(l.amount)<>0
   ORDER BY grouping(l.subsidiary_id) DESC,e.id,l.subsidiary_id
   LIMIT 1;
  IF FOUND THEN
    IF v_whole_entry=1 THEN
      RAISE EXCEPTION 'journal entry % does not balance (sum = %)',v_bad_entry,v_bad_total
        USING ERRCODE='23514';
    ELSE
      RAISE EXCEPTION 'journal entry % does not balance for subsidiary % (sum = %)',
        v_bad_entry,v_bad_subsidiary,v_bad_total USING ERRCODE='23514';
    END IF;
  END IF;

  -- Avoid another journal-line scan when none of these headers belongs to an
  -- organization with a configured custom balancing segment. A segment in a
  -- different organization cannot enable or satisfy this check.
  IF EXISTS (
    SELECT 1 FROM public.segment_definitions sd
    JOIN public.journal_entries e ON e.org_id=sd.org_id
    WHERE sd.source_kind='custom' AND sd.is_balancing
      AND e.id=ANY(p_entry_ids) AND e.status IS DISTINCT FROM 'draft'
  ) THEN
    SELECT e.id,sd.key,l.extra_dims->>sd.key,sum(l.amount)
      INTO v_bad_entry,v_bad_segment,v_bad_value,v_bad_total
      FROM public.journal_entries e
      JOIN public.journal_lines l ON l.entry_id=e.id AND l.org_id=e.org_id
      JOIN public.segment_definitions sd ON sd.org_id=e.org_id
        AND sd.source_kind='custom' AND sd.is_balancing
     WHERE e.id=ANY(p_entry_ids) AND e.status IS DISTINCT FROM 'draft'
     GROUP BY e.id,sd.key,l.extra_dims->>sd.key
    HAVING sum(l.amount)<>0
     ORDER BY e.id,sd.key,l.extra_dims->>sd.key
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'journal entry % does not balance for segment % value % (sum = %)',
        v_bad_entry,v_bad_segment,coalesce(v_bad_value,'<missing>'),v_bad_total
        USING ERRCODE='23514';
    END IF;
  END IF;
END $function$;
