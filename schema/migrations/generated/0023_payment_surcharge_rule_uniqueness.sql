-- OpenBooks forward migration 0023_payment_surcharge_rule_uniqueness.
--
-- Payment-provider setup checked for a conflicting surcharge rule before it
-- wrote, but the SELECT held no lock that another rule writer shared. Two
-- concurrent admins could therefore both observe an empty scope and commit
-- active rules that price the same provider/method during the same validity
-- window. The route keeps that preflight for its readable conflict response;
-- this exclusion constraint is the authoritative storage-side guard.
--
-- A unique index cannot enforce this invariant: two rows starting on different
-- dates are not equal even when their effective windows overlap. GiST exclusion
-- combines scalar equality for the pricing identity with date-range overlap.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- UUID/text equality operator classes are supplied by btree_gist. This
-- extension is mandatory: silently omitting it would silently omit a
-- money-movement configuration invariant.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE public.payment_surcharge_rules
  ADD CONSTRAINT payment_surcharge_rules_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    (COALESCE(provider, '__all_providers__'::text)) WITH =,
    payment_method WITH =,
    (daterange(effective_from, effective_to, '[]')) WITH &&
  )
  WHERE (is_active);

COMMENT ON CONSTRAINT payment_surcharge_rules_no_active_overlap
  ON public.payment_surcharge_rules IS
  'openbooks:payment_surcharge_rule_uniqueness:v1 - one active surcharge window per organization, provider tier, and payment method; inclusive date windows may not overlap';
