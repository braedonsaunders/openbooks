-- Effective-dated policy for projects whose estimated cost exceeds their contract value.
-- Off: no check. Warn: close readiness flags each such project lacking a loss assessment in the period.
-- Require: the same finding blocks the close until the governed loss assessment is applied.
-- Backfill: none. The policy table starts empty, which reads as off.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.project_loss_policies(id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid, UNIQUE(org_id,id),
 effective_from date NOT NULL,
 mode text NOT NULL CHECK(mode IN('off','warn','require')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 2000),
 UNIQUE(org_id,effective_from));
ALTER TABLE public.project_loss_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_loss_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.project_loss_policies
 USING((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.project_loss_policies IS 'openbooks:org_isolation:v1';
CREATE TRIGGER project_loss_policies_immutable BEFORE UPDATE OR DELETE ON public.project_loss_policies
 FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();
INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES
 ('project_loss_policies','0721_project_anticipated_loss_policy');
SELECT public.openbooks_refresh_query_catalog();
