-- Give imported tax groups readable codes instead of a source-system id suffix.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- A source system may give a tax item and a tax group the same name, while
-- tax codes are unique per organization. Earlier imports kept such groups
-- unique by appending the source record id ("HST [grp:2529]"), which then
-- appeared wherever the code is shown. Each such group takes its plain name
-- when that is free, otherwise "<name> (tax group)", then a numbered variant.
-- Only groups whose suffix matches their own stored source id are renamed;
-- documents reference tax codes by id, so no posted line changes. Every rename
-- records its before/after code in the audit log.
DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR r IN
    SELECT id, org_id, code, custom
      FROM public.tax_codes
     WHERE code ~ ' \[grp:[0-9]+\]$'
       AND custom->>'sourceRecordKind' = 'taxgroup'
     ORDER BY org_id, is_active DESC, code, id
  LOOP
    IF substring(r.code FROM ' \[grp:([0-9]+)\]$')
       IS DISTINCT FROM coalesce(r.custom->'source'->>'externalId', r.custom->>'nsId') THEN
      RAISE EXCEPTION 'tax code % in organization % carries a source id that does not match its own source record; rename it in Setup before upgrading',
        r.code, r.org_id;
    END IF;
    base := regexp_replace(r.code, ' \[grp:[0-9]+\]$', '');
    candidate := base;
    IF EXISTS (SELECT 1 FROM public.tax_codes t WHERE t.org_id = r.org_id AND t.code = candidate AND t.id <> r.id) THEN
      candidate := base || ' (tax group)';
      n := 2;
      WHILE EXISTS (SELECT 1 FROM public.tax_codes t WHERE t.org_id = r.org_id AND t.code = candidate AND t.id <> r.id) LOOP
        candidate := base || ' (tax group ' || n || ')';
        n := n + 1;
      END LOOP;
    END IF;
    UPDATE public.tax_codes SET code = candidate, updated_at = now()
     WHERE id = r.id AND org_id = r.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tax code % in organization % was not renamed', r.code, r.org_id;
    END IF;
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
    VALUES (r.org_id, 'tax_codes', r.id, 'update',
            jsonb_build_object('code', jsonb_build_array(r.code, candidate),
                               'reason', 'tax_group_readable_code'),
            NULL);
  END LOOP;
END $$;
