-- OpenBooks forward migration 0547_fx_rate_age_policies.
-- Effective-dated organization limits on how old an exchange rate may be when
-- FX revaluation and consolidation translation price a period: one limit for
-- closing (period-end spot) rates and one for period-average rates. A period
-- whose newest usable rate is older than the limit in force at its end date is
-- refused by name instead of being priced at a rate from a feed that stopped.
-- Without a row, the documented engine default applies.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.fx_rate_age_policies (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 rate_kind text NOT NULL,
 max_age_days integer NOT NULL,
 effective_from date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id),
 CONSTRAINT fx_rate_age_policies_effective_unique UNIQUE(org_id,rate_kind,effective_from),
 CONSTRAINT fx_rate_age_policies_rate_kind_check CHECK (rate_kind IN ('closing','average')),
 CONSTRAINT fx_rate_age_policies_max_age_check CHECK (max_age_days BETWEEN 0 AND 366)
);
ALTER TABLE public.fx_rate_age_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rate_age_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.fx_rate_age_policies
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.fx_rate_age_policies IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.fx_rate_age_policies IS
 'Effective-dated maximum exchange-rate age, in days, per rate kind (closing spot or period average). The row with the latest effective_from on or before a period end governs FX revaluation and consolidation translation of that period.';

-- A policy version is retained exactly as entered. Changing the limit requires
-- a new effective-dated version; ordinary writes cannot rewrite its history.
CREATE FUNCTION public.fx_rate_age_policy_history_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 RAISE EXCEPTION 'FX rate age policy history is preserved; create a new policy with its effective date in Setup → FX Rate Age Policies'
   USING ERRCODE = '23514';
END $$;
CREATE TRIGGER fx_rate_age_policy_history_guard
 BEFORE UPDATE OR DELETE ON public.fx_rate_age_policies
 FOR EACH ROW EXECUTE FUNCTION public.fx_rate_age_policy_history_guard();

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('fx_rate_age_policies', '0547_fx_rate_age_policies')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
