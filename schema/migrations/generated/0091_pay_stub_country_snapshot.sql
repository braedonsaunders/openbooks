-- OpenBooks forward migration 0091_pay_stub_country_snapshot.
-- Existing stubs already snapshot the work region. The two supported packs'
-- legacy region sets are disjoint; retain that historical fact, never the
-- employee's current profile country. Unrecognized legacy regions stay unknown.
ALTER TABLE public.pay_stubs ADD COLUMN country text;
ALTER TABLE public.pay_stubs ADD COLUMN country_source text NOT NULL DEFAULT 'unknown';

CREATE OR REPLACE FUNCTION public.payroll_legacy_region_country(region text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN region = ANY(ARRAY['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT', 'ZZ']::text[]) THEN 'CA'
    WHEN region = ANY(ARRAY['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']::text[]) THEN 'US'
    ELSE NULL
  END
$$;

UPDATE public.pay_stubs
   SET country = public.payroll_legacy_region_country(province),
       country_source = CASE WHEN public.payroll_legacy_region_country(province) IS NULL
                             THEN 'unknown' ELSE 'legacy_region' END;

ALTER TABLE public.pay_stubs ADD CONSTRAINT pay_stubs_country_evidence CHECK (
  (country IS NULL AND country_source = 'unknown') OR
  (country IS NOT NULL AND country ~ '^[A-Z]{2}$' AND country_source IN ('calculation', 'legacy_region'))
);

CREATE OR REPLACE FUNCTION public.pay_stub_country_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Rolling-deploy compatibility for old writers. New calculation code
    -- supplies the resolved pack country and its explicit source.
    IF NEW.country IS NULL THEN
      NEW.country := public.payroll_legacy_region_country(NEW.province);
      NEW.country_source := CASE WHEN NEW.country IS NULL THEN 'unknown' ELSE 'legacy_region' END;
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.country, NEW.country_source) IS DISTINCT FROM ROW(OLD.country, OLD.country_source) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_historical_country',
      MESSAGE = 'Payroll country is captured at calculation. Recalculate editable payroll or use a controlled correction; do not overwrite historical attribution.';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pay_stub_country_guard BEFORE INSERT OR UPDATE ON public.pay_stubs
FOR EACH ROW EXECUTE FUNCTION public.pay_stub_country_guard();

COMMENT ON COLUMN public.pay_stubs.country IS
  'Country of the statutory pack that calculated this stub; independent of the current employee profile.';
COMMENT ON COLUMN public.pay_stubs.country_source IS
  'calculation = captured directly; legacy_region = derived from the existing disjoint province/state snapshot; unknown = requires review before year-end reporting.';
SELECT public.openbooks_refresh_query_catalog();
