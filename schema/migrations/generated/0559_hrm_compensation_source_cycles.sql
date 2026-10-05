-- OpenBooks forward migration 0559_hrm_compensation_source_cycles.
-- Preserve historical compensation reviews as immutable source evidence.
-- Source records carry no native approval or payroll execution state. Unknown
-- source effective dates remain unknown; native cycles still require a date.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_comp_cycles ADD COLUMN source_key text;
ALTER TABLE public.hrm_comp_cycles ADD COLUMN source_evidence jsonb;
ALTER TABLE public.hrm_comp_cycles ALTER COLUMN effective_on DROP NOT NULL;
ALTER TABLE public.hrm_comp_cycles DROP CONSTRAINT hrm_comp_cycles_status;
ALTER TABLE public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_status CHECK (
  status IN ('draft', 'open', 'in_review', 'approved', 'pushed', 'closed', 'cancelled', 'historical')
);
ALTER TABLE public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_effective_date_required
  CHECK (status = 'historical' OR effective_on IS NOT NULL);
ALTER TABLE public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_source_origin CHECK (
  (status = 'historical') = (source_key IS NOT NULL AND source_evidence IS NOT NULL)
  AND (source_key IS NULL) = (source_evidence IS NULL)
  AND (source_evidence IS NULL OR jsonb_typeof(source_evidence) = 'object')
  AND (source_key IS NULL OR length(btrim(source_key)) > 0)
);
CREATE UNIQUE INDEX hrm_comp_cycles_source_key ON public.hrm_comp_cycles (org_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE FUNCTION public.preserve_historical_compensation_cycle() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF OLD.status = 'historical' THEN
    RAISE EXCEPTION 'Historical compensation source records are immutable; import a new source version to correct the evidence';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER preserve_historical_compensation_cycle
  BEFORE UPDATE OR DELETE ON public.hrm_comp_cycles
  FOR EACH ROW EXECUTE FUNCTION public.preserve_historical_compensation_cycle();
