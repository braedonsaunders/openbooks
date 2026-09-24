-- OpenBooks forward migration 0357_hrm_succession_candidate_order_unique.
-- A succession plan gives each candidate a distinct stable rank. Service
-- locking allocates ranks serially; this constraint arbitrates at storage.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_succession_candidates
  ADD CONSTRAINT hrm_succession_candidates_unique_order
  UNIQUE (plan_id, candidate_order);
