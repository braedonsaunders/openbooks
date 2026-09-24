-- OpenBooks forward migration 0344_hrm_succession_plan_notes.
--
-- F3-41: plan-level notes were shown in the succession dialog but the
-- succession plan API had nowhere to store them. Candidate notes remain on
-- their separate candidate rows.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_succession_plans
  ADD COLUMN notes text;
