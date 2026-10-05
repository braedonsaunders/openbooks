-- OpenBooks forward migration 0566_department_no_billable_expectation.
-- Departments with no billable expectation were inferred from zero billable
-- hours, so a quiet department silently left the company utilization rate.
-- The flag is now an explicit department attribute the operator sets: only
-- flagged departments are excluded from the company scope.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.departments ADD COLUMN no_billable_expectation boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.departments.no_billable_expectation IS 'Explicit operator flag: the department carries no billable expectation and is excluded from the company utilization scope. Defaults to false; previously inferred exclusions must be re-flagged explicitly.';
