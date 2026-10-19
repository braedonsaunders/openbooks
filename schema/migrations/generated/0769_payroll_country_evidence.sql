-- Country evidence is supplied by the calculating pack and never inferred from a work region.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.pay_stub_country_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    ROW(NEW.country, NEW.country_source) IS DISTINCT FROM ROW(OLD.country, OLD.country_source) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_historical_country',
      MESSAGE = 'Payroll country is captured at calculation. Recalculate editable payroll or use a controlled correction; do not overwrite historical attribution.';
  END IF;
  RETURN NEW;
END
$$;

DROP FUNCTION public.payroll_legacy_region_country(text);
SELECT public.openbooks_refresh_query_catalog();
