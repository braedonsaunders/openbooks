-- Each render of a report run records the authority it rendered under. A
-- scheduled render reads with the schedule owner's expense authority as it
-- stands at render time, so the run evidence gains an append-only `renders`
-- list: every render adds exactly one entry (when it rendered, the expense
-- report rows its content holds, and the rendered content's hash) and no
-- entry is ever changed or removed. The content-permission key keeps its
-- single write-once recording; every other evidence key stays immutable.
-- Only the trigger function body is replaced; the trigger keeps its name.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.protect_report_run_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_snapshot jsonb;
  old_renders jsonb;
  new_renders jsonb;
  entry jsonb;
  reach jsonb;
BEGIN
  IF NEW.authorization_snapshot IS NOT DISTINCT FROM OLD.authorization_snapshot THEN
    RETURN NEW;
  END IF;
  -- A missing snapshot behaves like an empty one: it may gain only the
  -- recorded keys below.
  old_snapshot := coalesce(OLD.authorization_snapshot, '{}'::jsonb);
  IF jsonb_typeof(old_snapshot) <> 'object' OR jsonb_typeof(NEW.authorization_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  -- Every key other than the two recorded ones is identical.
  IF (NEW.authorization_snapshot - 'requiredPermissions' - 'renders')
     IS DISTINCT FROM (old_snapshot - 'requiredPermissions' - 'renders') THEN
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  -- The content-permission key is recorded once, as an array, and never moves.
  IF old_snapshot ? 'requiredPermissions' THEN
    IF NEW.authorization_snapshot->'requiredPermissions' IS DISTINCT FROM old_snapshot->'requiredPermissions' THEN
      RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
    END IF;
  ELSIF NEW.authorization_snapshot ? 'requiredPermissions'
        AND jsonb_typeof(NEW.authorization_snapshot->'requiredPermissions') <> 'array' THEN
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  -- Render evidence is append-only: the earlier entries unchanged, plus at
  -- most one new, well-formed entry per write.
  IF old_snapshot ? 'renders' AND NOT NEW.authorization_snapshot ? 'renders' THEN
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  old_renders := coalesce(old_snapshot->'renders', '[]'::jsonb);
  new_renders := coalesce(NEW.authorization_snapshot->'renders', '[]'::jsonb);
  IF jsonb_typeof(old_renders) <> 'array' OR jsonb_typeof(new_renders) <> 'array' THEN
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  IF new_renders IS DISTINCT FROM old_renders THEN
    IF jsonb_array_length(new_renders) <> jsonb_array_length(old_renders) + 1
       OR (new_renders - (jsonb_array_length(new_renders) - 1)) IS DISTINCT FROM old_renders THEN
      RAISE EXCEPTION 'report run render evidence is append-only';
    END IF;
    entry := new_renders->(jsonb_array_length(new_renders) - 1);
    reach := entry->'expenseRows';
    IF jsonb_typeof(entry) <> 'object'
       OR (entry - 'renderedAt' - 'expenseRows' - 'contentHash') <> '{}'::jsonb
       OR jsonb_typeof(entry->'renderedAt') IS DISTINCT FROM 'string'
       OR NOT entry ? 'expenseRows'
       OR (entry ? 'contentHash' AND jsonb_typeof(entry->'contentHash') <> 'string')
       OR NOT (
         jsonb_typeof(reach) = 'null'
         OR (jsonb_typeof(reach) = 'object' AND reach IN ('{"scope":"all"}'::jsonb, '{"scope":"none"}'::jsonb))
         OR (jsonb_typeof(reach) = 'object' AND reach->>'scope' = 'own'
             AND jsonb_typeof(reach->'userId') = 'string' AND (reach - 'scope' - 'userId') = '{}'::jsonb)
       ) THEN
      RAISE EXCEPTION 'report run render evidence entry is malformed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
