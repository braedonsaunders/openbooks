-- Copied custom-segment assignments keep naming their own segment values.
--
-- A sandbox or sample-company copy rebases every segment value it copies, and with it each
-- custom-segment assignment (extra_dims) that names one. The financial-history clone admission
-- compares a copied journal line with its registered source row, so it now applies the same
-- rebasing to the source line's assignments before the comparison. The installed function body is
-- patched in place and verified against its published digest before and after.
--
-- The nonprofit framework guard admits the authorized sandbox wipe, like the other history guards,
-- so a sandbox or sample company holding fund-tagged postings can be deleted; ordinary removal of a
-- framework with fund-tagged history is still refused. Its body is patched and verified the same
-- way. Backfill: none. No row is rewritten.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

DO $clone_segment_assignments$
DECLARE proc record; replacement text;
BEGIN
 SELECT p.oid,p.prosrc INTO STRICT proc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='financial_history_native_clone_matches' AND p.pronargs=2;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')='3ed67fd21acf0cf5db9fa8c2837e1848a78af5437525ca85cd94a085633fb939' THEN
  RETURN; -- expected on replay: the assignment rebasing is already installed
 END IF;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')<>'8a78c1559eac3f4ca33a2b0408fcc8eb2f4b261eaf0efc22f11bc6267385d9c7' THEN
  RAISE EXCEPTION 'financial_history_native_clone_matches differs from its published definition; reconcile it before applying this migration' USING ERRCODE='55000';
 END IF;
 replacement:=replace(proc.prosrc,$anchor$ IF relation='public.journal_lines'::regclass AND target.masked THEN$anchor$,
  $block$ IF jsonb_typeof(expected->'extra_dims')='object' THEN
  expected:=jsonb_set(expected,'{extra_dims}',coalesce((SELECT jsonb_object_agg(dim.key,CASE
   WHEN jsonb_typeof(dim.value)='string' AND EXISTS(SELECT 1 FROM public.segment_values value_row
    WHERE value_row.org_id=target.sandbox_of AND value_row.id::text=dim.value #>> '{}')
   THEN to_jsonb(public.ob_rebase((dim.value #>> '{}')::uuid,target.sandbox_seed)::text) ELSE dim.value END)
   FROM jsonb_each(expected->'extra_dims') dim),'{}'::jsonb));
 END IF;
$block$ || $anchor$ IF relation='public.journal_lines'::regclass AND target.masked THEN$anchor$);
 IF encode(public.digest(replacement,'sha256'),'hex')<>'3ed67fd21acf0cf5db9fa8c2837e1848a78af5437525ca85cd94a085633fb939' THEN
  RAISE EXCEPTION 'financial_history_native_clone_matches assignment rebasing differs from its published body' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(pg_get_functiondef(proc.oid),proc.prosrc,replacement);
END $clone_segment_assignments$;

DO $nonprofit_framework_wipe$
DECLARE proc record; replacement text;
BEGIN
 SELECT p.oid,p.prosrc INTO STRICT proc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='nonprofit_frameworks_guard' AND p.pronargs=0;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')='550502ce39c94e0a304aedfee5e0060f4270326518d180e5c03e29e8dd9ec49c' THEN
  RETURN; -- expected on replay: the sandbox wipe admission is already installed
 END IF;
 IF encode(public.digest(proc.prosrc,'sha256'),'hex')<>'a5aa0ab60f87473d1af9fb43a96567dfda2449160a3e24909c219c8e31a38120' THEN
  RAISE EXCEPTION 'nonprofit_frameworks_guard differs from its published definition; reconcile it before applying this migration' USING ERRCODE='55000';
 END IF;
 replacement:=regexp_replace(proc.prosrc,'(\m[Bb][Ee][Gg][Ii][Nn]\M)','\1'||$wipe$
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
$wipe$);
 IF encode(public.digest(replacement,'sha256'),'hex')<>'550502ce39c94e0a304aedfee5e0060f4270326518d180e5c03e29e8dd9ec49c' THEN
  RAISE EXCEPTION 'nonprofit_frameworks_guard sandbox wipe admission differs from its published body' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(pg_get_functiondef(proc.oid),proc.prosrc,replacement);
END $nonprofit_framework_wipe$;
