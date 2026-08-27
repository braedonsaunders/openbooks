-- OpenBooks forward migration 0033_reporting_framework_policy.
--
-- GAAP versus IFRS is an accounting policy, not an inference from the
-- income-tax presentation policy.  Before this migration the reporting
-- engine treated taxFramework = 'ias12' as IFRS and every other value as US
-- GAAP when reportingFramework was absent.  Preserve that effective value
-- once, in the org settings document, so future reads have one authoritative
-- policy and tax edits cannot change posting behavior.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Deterministic, idempotent upgrade.  Invalid legacy values are treated as
-- absent and repaired using the exact pre-0033 effective rule; committed
-- lease and inventory evidence is not rewritten because those rows already
-- snapshot the framework used when they were posted.
UPDATE public.orgs
   SET settings = jsonb_set(
     COALESCE(settings, '{}'::jsonb),
     '{reportingFramework}',
     to_jsonb(
       CASE WHEN settings->>'taxFramework' = 'ias12' THEN 'ifrs' ELSE 'us_gaap' END
     ),
     true
   )
 WHERE settings->>'reportingFramework' IS NULL
    OR settings->>'reportingFramework' NOT IN ('us_gaap', 'ifrs');
