-- OpenBooks forward migration 0372_hrm_benefit_election_date_exclusion.
-- Prevent concurrent or alternate-path elections from overlapping for a plan.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE ONLY public.hrm_benefit_enrollments
  ADD CONSTRAINT hrm_benefit_enrollments_active_plan_range_excl
  EXCLUDE USING gist (
    org_id WITH =,
    employment_id WITH =,
    plan_id WITH =,
    (daterange(effective_from, COALESCE(effective_to, DATE '9999-12-31'), '[]')) WITH &&
  )
  WHERE (status IN ('elected', 'pending_approval', 'active'));
