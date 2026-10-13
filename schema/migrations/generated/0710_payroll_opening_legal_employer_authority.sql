-- Retained legal-employer source authority for payroll opening contributions.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.payroll_opening_employer_authorities (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL,
 opening_balance_id uuid NOT NULL,employee_party_id uuid NOT NULL,tax_year integer NOT NULL,
 subsidiary_id uuid NOT NULL,source_file_id uuid NOT NULL,source_version_id uuid NOT NULL,
 source_sha256 text NOT NULL,source_reference text NOT NULL,change_reason text NOT NULL,
 opening_snapshot jsonb NOT NULL,opening_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,
 CONSTRAINT payroll_opening_employer_authorities_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT payroll_opening_employer_authorities_opening_unique UNIQUE(org_id,opening_balance_id),
 CONSTRAINT payroll_opening_employer_authorities_employee_fkey FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id),
 CONSTRAINT payroll_opening_employer_authorities_employer_fkey FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 CONSTRAINT payroll_opening_employer_authorities_opening_fkey FOREIGN KEY(opening_balance_id) REFERENCES public.payroll_opening_balances(id),
 CONSTRAINT payroll_opening_employer_authorities_file_fkey FOREIGN KEY(source_file_id) REFERENCES public.files(id),
 CONSTRAINT payroll_opening_employer_authorities_version_fkey FOREIGN KEY(source_version_id) REFERENCES public.file_versions(id),
 CONSTRAINT payroll_opening_employer_authorities_source CHECK(source_sha256~'^[a-f0-9]{64}$' AND opening_sha256~'^[a-f0-9]{64}$'
   AND length(btrim(source_reference)) BETWEEN 1 AND 2000 AND length(btrim(change_reason)) BETWEEN 1 AND 2000),
 CONSTRAINT payroll_opening_employer_authorities_snapshot CHECK(jsonb_typeof(opening_snapshot)='object')
);
ALTER TABLE public.payroll_opening_employer_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_opening_employer_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_opening_employer_authorities
 USING((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.payroll_opening_employer_authorities IS 'openbooks:org_isolation:v1';

CREATE FUNCTION public.payroll_opening_employer_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE retained jsonb;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
  OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Qualified opening employer authority and original evidence are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id::text||':'||NEW.employee_party_id::text||':'||NEW.tax_year::text,0));
 SELECT to_jsonb(b) INTO retained FROM public.payroll_opening_balances b
  WHERE b.org_id=NEW.org_id AND b.id=NEW.opening_balance_id AND b.employee_party_id=NEW.employee_party_id AND b.tax_year=NEW.tax_year FOR SHARE;
 IF retained IS NULL OR retained IS DISTINCT FROM NEW.opening_snapshot
  OR encode(public.digest(retained::text,'sha256'),'hex')<>NEW.opening_sha256 THEN
  RAISE EXCEPTION 'Opening employer authority must retain the exact original employee/year amounts' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.worker_employments e WHERE e.org_id=NEW.org_id
  AND e.worker_party_id=NEW.employee_party_id AND e.employer_subsidiary_id=NEW.subsidiary_id) THEN
  RAISE EXCEPTION 'Opening employer authority requires the employee native legal employer' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
  WHERE f.org_id=NEW.org_id AND f.id=NEW.source_file_id AND NOT f.is_inactive AND v.id=NEW.source_version_id
   AND v.content_hash=NEW.source_sha256 AND v.created_by=NEW.created_by) THEN
  RAISE EXCEPTION 'Opening employer authority needs the importing operator exact retained source version and hash' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_opening_employer_authority_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.payroll_opening_employer_authorities FOR EACH ROW EXECUTE FUNCTION public.payroll_opening_employer_authority_guard();

CREATE FUNCTION public.payroll_opening_qualified_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
  OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||OLD.org_id::text||':'||OLD.employee_party_id::text||':'||OLD.tax_year::text,0));
 IF EXISTS(SELECT 1 FROM public.payroll_opening_employer_authorities a WHERE a.org_id=OLD.org_id AND a.opening_balance_id=OLD.id)
  AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
  RAISE EXCEPTION 'Source-qualified opening amounts must be preserved; use a governed payroll correction' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER payroll_opening_qualified_source_guard BEFORE UPDATE OR DELETE ON public.payroll_opening_balances
 FOR EACH ROW EXECUTE FUNCTION public.payroll_opening_qualified_source_guard();
