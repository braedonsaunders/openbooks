-- Sealed tax-authority credentials (HMRC VAT API OAuth, ABN Lookup GUID) and
-- stored ECB translation evidence for OSS returns filed in euro from
-- foreign-currency supplies. Both tables are org-isolated configuration and
-- filing evidence; neither reinterprets posted history.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.tax_authority_connections (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 authority text NOT NULL,
 sealed_credentials text,
 status text NOT NULL DEFAULT 'missing',
 token_expires_at timestamptz,
 last_error text,
 last_verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id),
 UNIQUE(org_id,authority),
 CONSTRAINT tax_authority_connections_authority_check CHECK (authority IN ('hmrc','abn')),
 CONSTRAINT tax_authority_connections_status_check CHECK (status IN ('missing','ready','error','expired'))
);
ALTER TABLE public.tax_authority_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_authority_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.tax_authority_connections
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.tax_authority_connections IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.tax_authority_connections IS
 'Sealed per-authority credentials for tax-ID validation: one row per organization and authority (HMRC VAT API OAuth client and tokens, ABN Lookup GUID). Secrets stay sealed; status and errors stay readable.';
COMMENT ON COLUMN public.tax_authority_connections.sealed_credentials IS
 'Sealed credential JSON (purpose tax.authority.<authority>); never decrypted outside the validating transaction.';

CREATE TABLE public.tax_oss_fx_evidence (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 scheme text NOT NULL,
 period_from date NOT NULL,
 period_to date NOT NULL,
 currency text NOT NULL,
 rate numeric(19,10) NOT NULL,
 rate_as_of date NOT NULL,
 rate_source text NOT NULL,
 evidence_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id),
 UNIQUE(org_id,scheme,period_from,period_to,currency),
 CONSTRAINT tax_oss_fx_evidence_scheme_check CHECK (scheme IN ('union','non_union','ioss')),
 CONSTRAINT tax_oss_fx_evidence_period_check CHECK (period_from <= period_to)
);
ALTER TABLE public.tax_oss_fx_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_oss_fx_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.tax_oss_fx_evidence
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.tax_oss_fx_evidence IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.tax_oss_fx_evidence IS
 'ECB spot-rate evidence behind OSS returns translated into euro: one row per return period and source currency with the rate date and reproducibility digest. Re-preparing a period converges on these rows; corrections travel as return correction lines, never as rewrites.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('tax_authority_connections', '0537_cross_border_tax_evidence'),
       ('tax_oss_fx_evidence', '0537_cross_border_tax_evidence')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
