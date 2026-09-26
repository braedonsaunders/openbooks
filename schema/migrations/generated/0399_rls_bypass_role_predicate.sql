-- OpenBooks forward migration 0399_rls_bypass_role_predicate.
--
-- RELEASE BLOCKER RLS-GUC-ESCALATION: about 840 policy expressions trusted the
-- raw app.bypass_rls GUC inline
-- (current_setting('app.bypass_rls'::text, true) = 'on'::text). The
-- The earlier role-bypass work moved the app server to a dedicated BYPASSRLS role, but
-- the policies never moved with it — so any SET on the runtime pool (SQL
-- injection, the sql.execute console, any code path issuing SET) escalated
-- across tenants. A runtime-role SET app.bypass_rls='on' exposed every org's
-- rows.
--
-- The fix, in this one migration:
--   1. ONE predicate, public.app_bypass_rls_active(): true only when the GUC
--      is 'on' AND the session login is privileged — a BYPASSRLS or superuser
--      role attribute, or a member of the role that owns this function (the
--      migration/installer owner that ran 0399). The runtime role never
--      qualifies, even with the GUC set. session_user (not current_user) is
--      tested so a SET ROLE inside the session cannot widen it; the upgrade
--      check's SET LOCAL ROLE openbooks_read proof keeps working because the
--      connecting login is what matters.
--   2. A generic rewrite of EVERY policy: iterate pg_policy, replace each
--      GUC-trust sub-expression with the predicate call, ALTER POLICY in
--      place (names, FOR/TO/roles, and comments untouched, so the bootstrap
--      openbooks:org_isolation:v1 drift check stays quiet). Never hand-lists
--      tables. The parser normalizes every authored spelling of the trust
--      expression to the single canonical cast form replaced below (verified
--      by probe: non-cast and compact file spellings deparse to it); any
--      policy whose remainder still names the GUC raises by name here, and
--      the closing assertion raises if any policy expression anywhere still
--      references app.bypass_rls outside the predicate.
--   3. Deliberately out of scope: function bodies that read the GUC.
--      openbooks_clone_authority()'s fourth conjunct is reworked by 0401
--      (arch-ledger), which calls this predicate. dunning_log_guard() and
--      protect_application_idempotency_key() still trust the raw GUC for
--      their append-only/immutability skips — reported to the coordinator as
--      residual same-class findings; they guard write shapes, not tenant
--      visibility, and rewriting plpgsql bodies by regex is not attempted.
--
-- Re-runnable: CREATE OR REPLACE converges the predicate, the rewrite loop
-- finds nothing on a clean catalog, and the assertion passes. Fresh installs
-- reach the same end state through the chain (earlier migrations may still
-- author inline-form policies; this migration rewrites them).
--
-- Composition with 0401 (arch-ledger clone authority): this migration
-- rewrites pg_policy expressions ONLY, never function bodies, so 0316's
-- authority body is untouched here; the closing assertion scans policies
-- only, so 0316's remaining GUC reference does not trip it.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Section 1: the single privileged-bypass predicate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_bypass_rls_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $func$
  SELECT current_setting('app.bypass_rls', true) = 'on'
     AND (
       -- Dedicated cross-tenant login (BYPASSRLS attribute), and any
       -- superuser: the local/CI bootstrap login doubles as the bypass pool
       -- (superusers imply rolbypassrls), and restores may connect as an
       -- explicitly controlled superuser.
       EXISTS (
         SELECT 1
           FROM pg_catalog.pg_roles
          WHERE rolname = session_user
            AND (rolbypassrls OR rolsuper)
       )
       -- Migration/installer owner: the role that owns this function, i.e.
       -- the login that ran this migration. Least-privilege owners (stock
       -- compose superuser-owners, host-managed NOBYPASSRLS owners, the
       -- one-shot installer pool) hold no bypass attribute, so ownership is
       -- the only stable mark — and it is transfer-proof: the test ownership
       -- transfer loop covers public/openbooks_query objects, and this
       -- function lives in public but bootstrap excludes it by name, so the
       -- runtime role can never become its owner. pg_has_role (not =) so a
       -- future owner that inherits the original still qualifies; the
       -- runtime role is never granted the owner role (communal-postgres.md:
       -- "never grant the owner role to the runtime role"), so it stays out.
       OR pg_catalog.pg_has_role(
            session_user,
            (SELECT proowner
               FROM pg_catalog.pg_proc
              WHERE oid = pg_catalog.to_regprocedure('public.app_bypass_rls_active()')),
            'MEMBER'
          )
     )
$func$;

COMMENT ON FUNCTION public.app_bypass_rls_active() IS
  'Single definition of privileged RLS bypass: true only when app.bypass_rls is ''on'' AND the session login holds BYPASSRLS/superuser or inherits this function''s owner (the migration/installer owner). The runtime role never qualifies. Policies must call this instead of trusting the GUC inline.';

-- Pin the default PUBLIC execute grant explicitly (idempotent): bootstrap
-- revokes EXECUTE FROM the runtime/bypass logins per function but never FROM
-- PUBLIC, and RLS policies evaluate this predicate as every session user, so
-- the PUBLIC grant is load-bearing, not incidental.
GRANT EXECUTE ON FUNCTION public.app_bypass_rls_active() TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Section 2: rewrite every policy generically.
-- ---------------------------------------------------------------------------
DO $rewrite$
DECLARE
  policy_row RECORD;
  old_qual text;
  old_check text;
  new_qual text;
  new_check text;
  alter_stmt text;
  rewritten int := 0;
BEGIN
  FOR policy_row IN
    SELECT n.nspname AS schemaname, c.relname AS tablename, p.polname AS policyname, p.polrelid AS relid
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE pg_catalog.pg_get_expr(p.polqual, p.polrelid) LIKE '%app.bypass_rls%'
        OR pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app.bypass_rls%'
     ORDER BY 1, 2, 3
  LOOP
    SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid),
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
      INTO old_qual, old_check
      FROM pg_catalog.pg_policy p
     WHERE p.polrelid = policy_row.relid
       AND p.polname = policy_row.policyname;
    -- The canonical stored spelling. The parser normalizes every authored
    -- variant (cast, non-cast, compact spacing) to this on storage.
    new_qual := regexp_replace(
      old_qual,
      'current_setting\(''app\.bypass_rls''::text, true\) = ''on''::text',
      'public.app_bypass_rls_active()',
      'g');
    new_check := regexp_replace(
      old_check,
      'current_setting\(''app\.bypass_rls''::text, true\) = ''on''::text',
      'public.app_bypass_rls_active()',
      'g');
    -- Fail closed: an exotic survivor (hand-made policy, unknown spelling)
    -- blocks the upgrade by name instead of persisting a hole.
    IF new_qual LIKE '%app.bypass_rls%' OR new_check LIKE '%app.bypass_rls%' THEN
      RAISE EXCEPTION '0399 cannot rewrite policy %.% (%): expression trusts app.bypass_rls in an unrecognized form (USING: % / WITH CHECK: %). Rewrite it to call public.app_bypass_rls_active() and re-run.',
        policy_row.schemaname, policy_row.tablename, policy_row.policyname,
        coalesce(new_qual, '(none)'), coalesce(new_check, '(none)');
    END IF;
    -- ALTER POLICY without FOR/TO preserves command, roles, permissiveness,
    -- and comments; only null clauses are omitted (e.g. USING on an
    -- insert-only policy), so each policy keeps its exact shape.
    alter_stmt := format('ALTER POLICY %I ON %I.%I',
      policy_row.policyname, policy_row.schemaname, policy_row.tablename);
    IF new_qual IS NOT NULL THEN
      alter_stmt := alter_stmt || format(' USING (%s)', new_qual);
    END IF;
    IF new_check IS NOT NULL THEN
      alter_stmt := alter_stmt || format(' WITH CHECK (%s)', new_check);
    END IF;
    EXECUTE alter_stmt;
    rewritten := rewritten + 1;
  END LOOP;
  RAISE NOTICE '0399 rewrote % policie(s) to public.app_bypass_rls_active()', rewritten;
END
$rewrite$;

-- ---------------------------------------------------------------------------
-- Section 3: assertion — no policy expression still trusts the raw GUC.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  offender RECORD;
BEGIN
  FOR offender IN
    SELECT n.nspname AS schemaname, c.relname AS tablename, p.polname AS policyname
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE pg_catalog.pg_get_expr(p.polqual, p.polrelid) LIKE '%app.bypass_rls%'
        OR pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app.bypass_rls%'
     ORDER BY 1, 2, 3
  LOOP
    RAISE EXCEPTION '0399 assertion failed: policy %.% (%) still references app.bypass_rls outside public.app_bypass_rls_active(); extend the section-2 rewrite and re-run.',
      offender.schemaname, offender.tablename, offender.policyname;
  END LOOP;
END
$assert$;
