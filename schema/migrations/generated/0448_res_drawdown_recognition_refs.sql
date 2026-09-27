-- OpenBooks forward migration 0448_res_drawdown_recognition_refs.
-- A monthly drawdown may create several recognition events, so the drawdown does not own one event id.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP VIEW IF EXISTS openbooks_query.res_retainer_drawdowns;

ALTER TABLE public.res_retainer_drawdowns
  DROP COLUMN recognition_event_id;

SELECT public.openbooks_refresh_query_catalog();
