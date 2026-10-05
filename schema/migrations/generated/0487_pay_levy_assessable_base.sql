-- Country-owned payroll setup data is provisioned by the installed pack.
-- This ordinal is retained so existing migration histories remain continuous.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

SELECT public.openbooks_refresh_query_catalog();
