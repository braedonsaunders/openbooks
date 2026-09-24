-- OpenBooks forward migration 0346_fx_rates_positive_rate.
-- FX observations are positive exchange ratios; zero and negative rates are invalid.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.fx_rates'::regclass
       AND conname = 'fx_rates_positive_rate'
  ) THEN
    ALTER TABLE public.fx_rates
      ADD CONSTRAINT fx_rates_positive_rate CHECK (rate > 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.fx_rates VALIDATE CONSTRAINT fx_rates_positive_rate;
