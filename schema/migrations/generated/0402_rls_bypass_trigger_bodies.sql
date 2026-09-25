-- OpenBooks forward migration 0402_rls_bypass_trigger_bodies.
--
-- RLS-GUC-TRIGGERS: 0399 closed the policy layer, but function and trigger
-- bodies that read the raw app.bypass_rls GUC stayed satisfiable by any role
-- with SET privilege. A runtime session sets the GUC (and any companion
-- flags) with no privilege check, so a body that trusts the raw comparison
-- honors a forger exactly where 0399 stopped honoring one.
--
-- The fix, in this one migration: a generic pg_proc sweep. Every
-- function/procedure body in the app schemas (public, openbooks_query) that
-- reads the raw GUC is re-created from its own pg_get_functiondef output
-- with each GUC-trust comparison replaced by a
-- public.app_bypass_rls_active() call. Rebuilding from the live definition
-- preserves everything else byte-for-byte: argument lists and defaults,
-- return type, language, volatility, SECURITY DEFINER/INVOKER, proconfig
-- (search_path et al), costs. Function bodies store source text (unlike
-- policy expressions, which the parser normalizes), so all authored
-- spellings are handled: plain, ::text-cast, and coalesce-wrapped
-- comparisons, matched case-insensitively with tolerant spacing.
--
-- Deliberately out of scope: public.openbooks_clone_authority(), whose
-- fourth conjunct is owned by arch-ledger and already calls the predicate
-- since the 0401 recut (167e0d441) — it is excluded from the sweep and the
-- assertion by name. public.app_bypass_rls_active() itself reads the GUC by
-- design and is likewise excluded.
--
-- Fail closed twice: a body whose remainder still names the raw GUC after
-- replacement (an unrecognized form, or a bare read with no comparison)
-- raises by function name instead of persisting a hole; the closing
-- assertion raises if any in-scope body anywhere still references the raw
-- GUC outside the predicate.
--
-- Re-runnable: definitions converge (a second run finds no raw reads), the
-- assertion passes on a clean catalog, and CREATE OR REPLACE never changes
-- ownership, so the predicate's owner anchor from 0399 is untouched.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Section 1: rewrite every in-scope function/trigger body generically.
-- ---------------------------------------------------------------------------
DO $sweep$
DECLARE
  func RECORD;
  def text;
  newdef text;
  rewritten int := 0;
BEGIN
  FOR func IN
    SELECT p.oid AS funcoid, n.nspname AS schemaname, p.proname AS funcname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'openbooks_query')
       AND p.prokind IN ('f', 'p')
       AND p.proname NOT IN ('app_bypass_rls_active', 'openbooks_clone_authority')
       AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_depend d
              WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid
                AND d.deptype = 'e'
           )
       AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%app.bypass_rls%'
     ORDER BY 1, 2
  LOOP
    def := pg_catalog.pg_get_functiondef(func.funcoid);
    newdef := def;
    -- Coalesce-wrapped read first (longest match wins if forms nest).
    newdef := regexp_replace(newdef,
      'coalesce\s*\(\s*current_setting\s*\(\s*''app\.bypass_rls''(::text)?\s*,\s*true\s*\)\s*,\s*''off''(::text)?\s*\)\s*=\s*''on''(::text)?',
      'public.app_bypass_rls_active()', 'gi');
    -- Plain and ::text-cast comparisons, any spacing or keyword case.
    newdef := regexp_replace(newdef,
      'current_setting\s*\(\s*''app\.bypass_rls''(::text)?\s*,\s*true\s*\)\s*=\s*''on''(::text)?',
      'public.app_bypass_rls_active()', 'gi');
    -- Fail closed: an exotic survivor (unknown spelling, bare read with no
    -- comparison, mention in a message) blocks the upgrade by name instead
    -- of persisting a hole. The predicate call itself cannot trip this: it
    -- spells the name with underscores, never app.bypass_rls with a dot.
    IF newdef LIKE '%app.bypass_rls%' THEN
      RAISE EXCEPTION '0402 cannot rewrite function %.% (%): body still references app.bypass_rls after replacement. Rewrite the arm to call public.app_bypass_rls_active() and re-run.',
        func.schemaname, func.funcname, func.funcoid::regprocedure::text;
    END IF;
    IF newdef <> def THEN
      EXECUTE newdef;
      rewritten := rewritten + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0402 rewrote % function/trigger bodie(s) to public.app_bypass_rls_active()', rewritten;
END
$sweep$;

-- ---------------------------------------------------------------------------
-- Section 2: assertion — no in-scope body still trusts the raw GUC.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  offender RECORD;
BEGIN
  FOR offender IN
    SELECT n.nspname AS schemaname, p.proname AS funcname,
           p.oid::regprocedure::text AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'openbooks_query')
       AND p.prokind IN ('f', 'p')
       AND p.proname NOT IN ('app_bypass_rls_active', 'openbooks_clone_authority')
       AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_depend d
              WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid
                AND d.deptype = 'e'
           )
       AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%app.bypass_rls%'
     ORDER BY 1, 2
  LOOP
    RAISE EXCEPTION '0402 assertion failed: function body %.% (%) still references app.bypass_rls outside public.app_bypass_rls_active(); extend the section-1 rewrite and re-run.',
      offender.schemaname, offender.funcname, offender.signature;
  END LOOP;
END
$assert$;
