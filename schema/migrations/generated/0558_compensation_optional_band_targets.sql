-- OpenBooks forward migration 0558_compensation_optional_band_targets.
-- Preserve pay ranges whose approved policy specifies bounds without a target.
-- Existing targets and effective-dated history remain unchanged. Calculations
-- requiring a target refuse until an approved target is configured.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_pay_bands ALTER COLUMN target DROP NOT NULL;
ALTER TABLE public.hrm_pay_bands DROP CONSTRAINT hrm_pay_bands_ordered;
ALTER TABLE public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_ordered
  CHECK (min <= max AND (target IS NULL OR (min <= target AND target <= max)));
ALTER TABLE public.hrm_pay_bands DROP CONSTRAINT hrm_pay_bands_positive;
ALTER TABLE public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_positive
  CHECK (min > 0 AND max > 0 AND (target IS NULL OR target > 0));
