-- OpenBooks forward migration 0462_prepaid_breakage_assessments.
-- Retain native grant, contract and legal-entity binding for approved breakage estimates.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);
CREATE INDEX financial_changes_prepaid_breakage ON public.financial_changes(org_id,(payload->>'grantId'),effective_on)
  WHERE domain='revenue' AND operation='expected_breakage_estimate' AND status='applied';
CREATE FUNCTION public.prepaid_breakage_change_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.domain='revenue' AND NEW.operation='expected_breakage_estimate' AND NOT EXISTS(
    SELECT 1 FROM public.usage_prepaid_grants g
      JOIN public.document_lines line ON line.org_id=g.org_id AND line.id=g.source_document_line_id
      JOIN public.documents document ON document.org_id=line.org_id AND document.id=line.document_id
      JOIN public.performance_obligations obligation ON obligation.org_id=line.org_id AND obligation.document_line_id=line.id
      JOIN public.revenue_contracts contract ON contract.org_id=obligation.org_id AND contract.id=obligation.contract_id
    WHERE g.org_id=NEW.org_id AND g.id=(NEW.payload->>'grantId')::uuid AND contract.id=NEW.subject_id
      AND coalesce(contract.subsidiary_id,line.subsidiary_id,document.subsidiary_id)=NEW.subsidiary_id
      AND NEW.payload->'requiredSubsidiaryIds'=jsonb_build_array(NEW.subsidiary_id::text)
      AND jsonb_typeof(NEW.before_state->'estimates')='array'
  ) THEN RAISE EXCEPTION 'breakage estimate must bind to its prepaid grant, revenue contract and legal entity'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prepaid_breakage_change_binding BEFORE INSERT OR UPDATE ON public.financial_changes
  FOR EACH ROW EXECUTE FUNCTION public.prepaid_breakage_change_binding();
SELECT public.openbooks_refresh_query_catalog();
