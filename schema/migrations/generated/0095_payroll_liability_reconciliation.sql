-- OpenBooks forward migration 0095_payroll_liability_reconciliation.
-- Forward-only extension: preserve all existing liability stamps and balances.
ALTER TABLE public.pay_stub_lines ADD COLUMN liability_account_evidence jsonb;
ALTER TABLE public.pay_stub_lines DROP CONSTRAINT pay_stub_lines_liability_account_evidence;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_liability_account_evidence CHECK (
  (liability_account_source = 'unknown' AND liability_account_id IS NULL AND liability_account_evidence IS NULL) OR
  (liability_account_source IN ('commit','legacy_component') AND liability_account_id IS NOT NULL AND liability_account_evidence IS NULL) OR
  (liability_account_source = 'reconciled' AND liability_account_id IS NOT NULL AND liability_account_evidence IS NOT NULL
    AND jsonb_typeof(liability_account_evidence) = 'object'
    AND coalesce(jsonb_typeof(liability_account_evidence->'reason') = 'string',false)
    AND coalesce(jsonb_typeof(liability_account_evidence->'reference') = 'string',false)
    AND length(trim(liability_account_evidence->>'reason')) > 0
    AND length(trim(liability_account_evidence->>'reference')) > 0)
);
CREATE OR REPLACE FUNCTION public.pay_stub_line_liability_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE committed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.liability_account_source = 'reconciled' THEN
      RAISE EXCEPTION 'Liability reconciliation must resolve an existing unknown payroll line.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.org_id,NEW.liability_account_id,NEW.liability_account_source,NEW.liability_account_evidence)
     IS NOT DISTINCT FROM ROW(OLD.org_id,OLD.liability_account_id,OLD.liability_account_source,OLD.liability_account_evidence) THEN
    RETURN NEW;
  END IF;
  IF OLD.liability_account_source <> 'unknown' THEN
    RAISE EXCEPTION 'The liability account a committed payroll line accrued to is immutable.' USING ERRCODE='23514';
  END IF;
  SELECT r.run_status='committed' INTO committed FROM public.pay_stubs s
    JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id
   WHERE s.org_id=OLD.org_id AND s.id=OLD.stub_id;
  IF NEW.liability_account_source = 'commit' AND committed IS FALSE AND NEW.org_id=OLD.org_id THEN
    RETURN NEW; -- normal commit captures its account before marking the run committed
  END IF;
  IF NEW.liability_account_source <> 'reconciled' OR committed IS NOT TRUE OR NEW.updated_by IS NULL
     OR OLD.kind NOT IN ('deduction','employer_contribution')
     OR (to_jsonb(NEW) - ARRAY['liability_account_id','liability_account_source','liability_account_evidence','updated_at','updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['liability_account_id','liability_account_source','liability_account_evidence','updated_at','updated_by']) THEN
    RAISE EXCEPTION 'Only unknown committed liabilities may be reconciled, with original evidence and without changing payroll amounts.' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.liability_account_id
    AND NOT a.is_summary AND a.type LIKE 'liability%') THEN
    RAISE EXCEPTION 'Historical payroll liability must reference a posting liability account in the same organization.' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
  VALUES(NEW.org_id,'pay_stub_lines',NEW.id,'update',jsonb_build_object(
    'operation','reconcile_liability_account','before',to_jsonb(OLD),'after',to_jsonb(NEW),
    'evidence',NEW.liability_account_evidence),NEW.updated_by);
  RETURN NEW;
END
$$;
DROP TRIGGER pay_stub_line_liability_guard ON public.pay_stub_lines;
CREATE TRIGGER pay_stub_line_liability_guard BEFORE INSERT OR UPDATE ON public.pay_stub_lines
FOR EACH ROW EXECUTE FUNCTION public.pay_stub_line_liability_guard();
COMMENT ON COLUMN public.pay_stub_lines.liability_account_evidence IS
  'Original posting evidence reference and reason for a one-time audited resolution of an unknown historical liability account.';
SELECT public.openbooks_refresh_query_catalog();
