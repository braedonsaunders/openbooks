-- OpenBooks forward migration 0589_pre_billing_names.
-- Use Pre-billing names for worksheet storage, feature configuration and Flows.
-- Relation renames retain row identities, grants, isolation policies and history.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.wip_prebills RENAME TO prebills;
ALTER TABLE public.wip_prebill_lines RENAME TO prebill_lines;
ALTER TABLE public.wip_prebill_events RENAME TO prebill_events;
ALTER TABLE public.wip_holds RENAME TO prebill_holds;

-- Constraint-backed indexes follow their constraint rename. Rename remaining
-- indexes and triggers separately without rebuilding or disabling any guard.
DO $rename_objects$
DECLARE object record; replacement text;
BEGIN
  FOR object IN
    SELECT c.conname, c.conrelid::regclass AS relation
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid IN ('public.prebills'::regclass, 'public.prebill_lines'::regclass,
                         'public.prebill_events'::regclass, 'public.prebill_holds'::regclass)
       AND c.conname LIKE 'wip\_%' ESCAPE '\'
  LOOP
    replacement := regexp_replace(object.conname, '^wip_(prebill|hold|event)',
                                  CASE WHEN object.conname LIKE 'wip_hold%' THEN 'prebill_hold'
                                       WHEN object.conname LIKE 'wip_event%' THEN 'prebill_event'
                                       ELSE 'prebill' END);
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', object.relation, object.conname, replacement);
  END LOOP;
  FOR object IN
    SELECT c.relname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
     WHERE i.indrelid IN ('public.prebills'::regclass, 'public.prebill_lines'::regclass,
                         'public.prebill_events'::regclass, 'public.prebill_holds'::regclass)
       AND c.relname LIKE 'wip\_%' ESCAPE '\'
  LOOP
    replacement := replace(replace(object.relname, 'wip_prebill', 'prebill'), 'wip_hold', 'prebill_hold');
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', object.relname, replacement);
  END LOOP;
  FOR object IN
    SELECT t.tgname, t.tgrelid::regclass AS relation FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid IN ('public.prebills'::regclass, 'public.prebill_lines'::regclass,
                        'public.prebill_events'::regclass, 'public.prebill_holds'::regclass)
       AND NOT t.tgisinternal AND t.tgname LIKE 'wip\_%' ESCAPE '\'
  LOOP
    replacement := replace(object.tgname, 'wip_prebill', 'prebill');
    EXECUTE format('ALTER TRIGGER %I ON %s RENAME TO %I', object.tgname, object.relation, replacement);
  END LOOP;
END
$rename_objects$;

ALTER FUNCTION public.wip_prebill_event_append_only_guard() RENAME TO prebill_event_append_only_guard;
CREATE OR REPLACE FUNCTION public.prebill_event_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Prebill events are append-only';
END $$;

ALTER FUNCTION public.wip_prebill_source_reservation_guard() RENAME TO prebill_source_reservation_guard;
CREATE OR REPLACE FUNCTION public.prebill_source_reservation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_status text; source_key uuid;
BEGIN
  SELECT status INTO parent_status FROM public.prebills WHERE org_id=NEW.org_id AND id=NEW.prebill_id;
  IF parent_status NOT IN ('draft','review','approved','customer_review') THEN RETURN NEW; END IF;
  source_key := coalesce(NEW.time_entry_id, NEW.document_line_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text||':'||NEW.source_type||':'||source_key::text,0));
  IF EXISTS (SELECT 1 FROM public.prebill_lines line JOIN public.prebills worksheet
               ON worksheet.org_id=line.org_id AND worksheet.id=line.prebill_id
              WHERE line.org_id=NEW.org_id AND line.id<>NEW.id AND line.source_type=NEW.source_type
                AND coalesce(line.time_entry_id,line.document_line_id)=source_key
                AND worksheet.status IN ('draft','review','approved','customer_review'))
  THEN RAISE EXCEPTION 'Source is already reserved by an active prebill'; END IF;
  RETURN NEW;
END $$;

-- The governed query registry and masking policy must point at the same
-- renamed relations as the native services. Audit entries keep their original
-- identifiers so historical evidence remains immutable.
UPDATE public.openbooks_query_catalog_relations
   SET relation = CASE relation WHEN 'wip_prebills' THEN 'prebills'
                               WHEN 'wip_prebill_lines' THEN 'prebill_lines'
                               WHEN 'wip_prebill_events' THEN 'prebill_events'
                               WHEN 'wip_holds' THEN 'prebill_holds' END
 WHERE relation IN ('wip_prebills','wip_prebill_lines','wip_prebill_events','wip_holds');
DO $catalog_identity$
BEGIN
  IF (SELECT count(*) FROM public.openbooks_query_catalog_relations
       WHERE relation IN ('prebills','prebill_lines','prebill_events','prebill_holds')) <> 4
  THEN RAISE EXCEPTION 'Pre-billing query catalog must resolve all four renamed relations'; END IF;
END $catalog_identity$;

UPDATE public.masking_policies
   SET table_name = CASE table_name WHEN 'wip_prebills' THEN 'prebills'
                                   WHEN 'wip_prebill_lines' THEN 'prebill_lines'
                                   WHEN 'wip_prebill_events' THEN 'prebill_events'
                                   WHEN 'wip_holds' THEN 'prebill_holds' END
 WHERE table_name IN ('wip_prebills','wip_prebill_lines','wip_prebill_events','wip_holds');

-- An explicit false stays false; absent feature configuration stays absent.
-- A conflicting pair of old/new switches is refused before either is removed.
DO $feature_names$
BEGIN
  IF EXISTS (SELECT 1 FROM public.orgs WHERE settings->'features' ? 'wipBilling'
               AND settings->'features' ? 'preBilling'
               AND settings->'features'->'wipBilling' IS DISTINCT FROM settings->'features'->'preBilling')
  THEN RAISE EXCEPTION 'Pre-billing feature settings conflict; reconcile Company Settings before upgrading'; END IF;
END $feature_names$;
WITH prior AS (
  SELECT id, settings->'features' AS features FROM public.orgs
   WHERE settings->'features' ? 'wipBilling' FOR UPDATE
), changed AS (
  UPDATE public.orgs o
     SET settings = jsonb_set(o.settings, '{features}',
                              (prior.features - 'wipBilling') || jsonb_build_object('preBilling', prior.features->'wipBilling'))
    FROM prior WHERE o.id = prior.id
  RETURNING o.id, prior.features AS before_features, o.settings->'features' AS after_features
)
INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes)
SELECT id, 'orgs', id, 'update', jsonb_build_object('reason','Rename the Pre-billing feature setting',
       'before',jsonb_build_object('features',before_features), 'after',jsonb_build_object('features',after_features))
  FROM changed;

UPDATE public.flows SET subject_kind = 'prebill' WHERE subject_kind = 'wip_prebill';
UPDATE public.flow_runs SET subject_kind = 'prebill' WHERE subject_kind = 'wip_prebill';
UPDATE public.flow_gates SET subject_kind = 'prebill' WHERE subject_kind = 'wip_prebill';
UPDATE public.flow_locks SET subject_kind = 'prebill' WHERE subject_kind = 'wip_prebill';
UPDATE public.notifications SET href = '/projects/pre-billing' || substr(href, length('/projects/wip-billing') + 1)
 WHERE href = '/projects/wip-billing' OR href LIKE '/projects/wip-billing?%';

SELECT public.openbooks_refresh_query_catalog();
