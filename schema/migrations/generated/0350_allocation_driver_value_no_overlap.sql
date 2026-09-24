-- OpenBooks forward migration 0350_allocation_driver_value_no_overlap.
-- Application overlap checks provide a useful refusal; this exclusion
-- constraint arbitrates concurrent writers at the storage boundary.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE public.allocation_driver_values
  ADD CONSTRAINT allocation_driver_values_no_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    driver_id WITH =,
    dimension_value_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
