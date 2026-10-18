-- Complete tenant retirement coverage.
--
-- Fence every tenant table that does not yet carry the tenant retirement guard, so a retiring
-- organization's rows cannot change while its retirement is in progress and retirement planning
-- sees a complete fence set. The set is derived from the catalog: each public table with org_id
-- and no trigger named tenant_retirement_fence receives the native fence. A table whose existing
-- tenant_retirement_fence trigger is not the native one refuses the migration instead of being
-- replaced.
--
-- The reconciliation match guard admits tenant retirement deletes like every other
-- retirement-contracted guard; its installed body is patched in place and verified against its
-- published digest before and after.
--
-- A segment's default value reference checks at the end of the statement or, when the transaction
-- defers its constraints, at commit, instead of immediately. Ordinary deletes of a default value
-- are still refused; tenant retirement, which defers constraints, can remove a segment and its
-- values together without changing either. Backfill: none. No row is rewritten.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

DO $fences$
DECLARE target record;
BEGIN
 IF to_regprocedure('tenant_retirement.openbooks_tenant_retirement_fence()') IS NULL THEN
  RAISE EXCEPTION 'The tenant retirement fence function is not installed; apply the retirement migrations through the native runner first.' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND t.tgname='tenant_retirement_fence' AND NOT t.tgisinternal
     AND (t.tgfoid<>'tenant_retirement.openbooks_tenant_retirement_fence()'::regprocedure
       OR t.tgtype::integer<>CASE WHEN c.relname='orgs' THEN 27 ELSE 31 END OR t.tgenabled NOT IN ('O','A'))) THEN
  RAISE EXCEPTION 'An existing tenant_retirement_fence trigger is not the native fence; preserve it and reconcile its definition before applying this migration.' USING ERRCODE='55000';
 END IF;
 FOR target IN
  SELECT c.oid AS relation_id, c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname<>'orgs'
     AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='org_id' AND NOT a.attisdropped)
   ORDER BY (c.relkind='p') DESC, c.relname
 LOOP
  -- A partitioned parent's fence is cloned onto its partitions, so each table is checked when reached.
  CONTINUE WHEN EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=target.relation_id AND t.tgname='tenant_retirement_fence');
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()',
   target.table_name);
 END LOOP;
END $fences$;

DO $reconciliation_match_retirement$
DECLARE proc record; replacement text;
BEGIN
 SELECT p.oid,p.prosrc INTO STRICT proc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='openbooks_reconciliation_match_guard' AND p.pronargs=0;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')='9f1e32b854b8f966e1e37afbac93f1b5bbebbcd05b151da05cb12f64b868ca3b' THEN
  RETURN; -- expected on replay: the retirement authority is already installed
 END IF;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')<>'442f7133e0dac3816cf6a89622434315cc35e2f7ec24550b6de6d33584311de1' THEN
  RAISE EXCEPTION 'openbooks_reconciliation_match_guard differs from its published definition; reconcile it before applying this migration' USING ERRCODE='55000';
 END IF;
 replacement:=regexp_replace(proc.prosrc,'(\m[Bb][Ee][Gg][Ii][Nn]\M)',E'\\1\n  IF TG_OP = ''DELETE'' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN\n    RETURN OLD;\n  END IF;\n');
 IF encode(public.digest(replacement,'sha256'),'hex')<>'9f1e32b854b8f966e1e37afbac93f1b5bbebbcd05b151da05cb12f64b868ca3b' THEN
  RAISE EXCEPTION 'openbooks_reconciliation_match_guard retirement authority differs from its published body' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(pg_get_functiondef(proc.oid),proc.prosrc,replacement);
END $reconciliation_match_retirement$;

DO $segment_default_reference$
DECLARE definition text;
BEGIN
 SELECT pg_get_constraintdef(k.oid) INTO definition FROM pg_constraint k
  WHERE k.conrelid='public.segment_definitions'::regclass AND k.conname='segment_definitions_default_value_fkey';
 IF definition='FOREIGN KEY (org_id, default_value_id) REFERENCES segment_values(org_id, id) DEFERRABLE' THEN
  RETURN; -- expected on replay: the reference already checks at statement end or commit
 END IF;
 IF definition IS DISTINCT FROM 'FOREIGN KEY (org_id, default_value_id) REFERENCES segment_values(org_id, id) ON DELETE RESTRICT DEFERRABLE' THEN
  RAISE EXCEPTION 'segment_definitions_default_value_fkey differs from its published definition; reconcile it before applying this migration' USING ERRCODE='55000';
 END IF;
 ALTER TABLE public.segment_definitions DROP CONSTRAINT segment_definitions_default_value_fkey;
 ALTER TABLE public.segment_definitions ADD CONSTRAINT segment_definitions_default_value_fkey
  FOREIGN KEY (org_id, default_value_id) REFERENCES public.segment_values (org_id, id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
 ALTER TABLE public.segment_definitions VALIDATE CONSTRAINT segment_definitions_default_value_fkey;
END $segment_default_reference$;
