-- Claim approved holiday obligations once and retain settlement history through payroll reversal.
CREATE TABLE public.pay_run_holiday_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 obligation_id uuid NOT NULL, pay_run_document_id uuid NOT NULL, pay_stub_line_id uuid,
 component_id uuid NOT NULL, amount numeric(19,4) NOT NULL CHECK(amount>=0),
 hours numeric(12,2) NOT NULL CHECK(hours>0), rate numeric(19,4) NOT NULL CHECK(rate>0),
 currency text NOT NULL REFERENCES public.currencies(code), source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
 status text NOT NULL DEFAULT 'calculated' CHECK(status IN('calculated','committed','voided')),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,pay_run_document_id,obligation_id),
 FOREIGN KEY(org_id,obligation_id) REFERENCES public.payroll_holiday_obligations(org_id,id),
 FOREIGN KEY(org_id,pay_run_document_id) REFERENCES public.pay_runs(org_id,document_id),
 FOREIGN KEY(org_id,pay_stub_line_id) REFERENCES public.pay_stub_lines(org_id,id),
 FOREIGN KEY(org_id,component_id) REFERENCES public.pay_components(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id)
);
CREATE UNIQUE INDEX pay_run_holiday_allocations_active_claim ON public.pay_run_holiday_allocations(org_id,obligation_id) WHERE status<>'voided';

CREATE FUNCTION public.payroll_holiday_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE run_row public.pay_runs%ROWTYPE; obligation public.payroll_holiday_obligations%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO STRICT run_row FROM public.pay_runs WHERE org_id=NEW.org_id AND document_id=NEW.pay_run_document_id FOR SHARE;
  SELECT * INTO STRICT obligation FROM public.payroll_holiday_obligations WHERE org_id=NEW.org_id AND id=NEW.obligation_id FOR SHARE;
  IF NEW.status<>'calculated' OR run_row.run_status NOT IN('draft','calculated') OR run_row.run_type<>'regular'
    OR run_row.pay_date IS DISTINCT FROM obligation.payment_date
    OR NEW.hours::text::numeric IS DISTINCT FROM (obligation.evidence->'instruction'->>'hours')::numeric
    OR NEW.source_snapshot->'obligation' IS DISTINCT FROM obligation.evidence
    OR NOT EXISTS(SELECT 1 FROM public.documents d WHERE d.org_id=NEW.org_id AND d.id=NEW.pay_run_document_id
        AND d.subsidiary_id=obligation.subsidiary_id AND d.currency=NEW.currency)
    OR NOT EXISTS(SELECT 1 FROM public.financial_changes f WHERE f.org_id=obligation.org_id AND f.id=obligation.change_id AND f.status='applied')
    OR NOT EXISTS(SELECT 1 FROM public.pay_components c WHERE c.org_id=NEW.org_id AND c.id=NEW.component_id AND c.system_key='stat_holiday' AND c.kind='earning') THEN
   RAISE EXCEPTION 'Holiday settlement must claim an applied unpaid entitlement on its instructed regular pay date with exact source hours and the native holiday component.';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT run_row FROM public.pay_runs WHERE org_id=OLD.org_id AND document_id=OLD.pay_run_document_id FOR SHARE;
 IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND
    ((OLD.status='calculated' AND NEW.status='committed' AND run_row.run_status='calculated') OR
     (OLD.status='committed' AND NEW.status='voided' AND run_row.run_status='committed')) AND
    (to_jsonb(NEW)-ARRAY['status','updated_at','updated_by'])=(to_jsonb(OLD)-ARRAY['status','updated_at','updated_by']) THEN RETURN NEW; END IF;
 IF OLD.status<>'calculated' OR run_row.run_status NOT IN('draft','calculated') THEN
  RAISE EXCEPTION 'Committed holiday settlement evidence is immutable; void its native payroll before releasing the claim.';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.status<>'calculated' OR (to_jsonb(NEW)-ARRAY['pay_stub_line_id','updated_at','updated_by']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['pay_stub_line_id','updated_at','updated_by']) THEN
  RAISE EXCEPTION 'Calculated holiday pricing is frozen; recalculate the editable payroll instead of rewriting its claim.';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_holiday_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pay_run_holiday_allocations
 FOR EACH ROW EXECUTE FUNCTION public.payroll_holiday_allocation_guard();

CREATE FUNCTION public.payroll_holiday_run_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 IF NEW.run_status='committed' AND OLD.run_status<>'committed' THEN
  IF EXISTS(SELECT 1 FROM public.pay_run_holiday_allocations a
    JOIN public.payroll_holiday_obligations o ON o.org_id=a.org_id AND o.id=a.obligation_id
    JOIN public.documents d ON d.org_id=a.org_id AND d.id=a.pay_run_document_id
    LEFT JOIN public.pay_stub_lines l ON l.org_id=a.org_id AND l.id=a.pay_stub_line_id
    LEFT JOIN public.pay_stubs s ON s.org_id=l.org_id AND s.id=l.stub_id
    WHERE a.org_id=NEW.org_id AND a.pay_run_document_id=NEW.document_id AND
      (a.status<>'calculated' OR d.subsidiary_id IS DISTINCT FROM o.subsidiary_id OR d.currency IS DISTINCT FROM a.currency
       OR l.id IS NULL OR s.pay_run_document_id IS DISTINCT FROM NEW.document_id
       OR s.employee_party_id IS DISTINCT FROM o.employee_party_id OR s.employment_id IS DISTINCT FROM o.employment_id
       OR s.currency_code IS DISTINCT FROM a.currency OR l.component_id IS DISTINCT FROM a.component_id
       OR l.amount IS DISTINCT FROM a.amount OR l.hours IS DISTINCT FROM a.hours OR l.rate IS DISTINCT FROM a.rate)) THEN
   RAISE EXCEPTION 'A holiday claim must resolve to its exact employee, employment, currency, component, hours, rate and native payroll amount before commit.';
  END IF;
  IF NEW.run_type='regular' AND EXISTS(SELECT 1 FROM public.payroll_holiday_obligations o
    JOIN public.pay_stubs s ON s.org_id=o.org_id AND s.employee_party_id=o.employee_party_id AND s.employment_id=o.employment_id
    WHERE o.org_id=NEW.org_id AND s.pay_run_document_id=NEW.document_id AND o.payment_date=NEW.pay_date
      AND NOT EXISTS(SELECT 1 FROM public.pay_run_holiday_allocations a WHERE a.org_id=o.org_id AND a.obligation_id=o.id
        AND a.pay_run_document_id=NEW.document_id AND a.status='calculated')) THEN
   RAISE EXCEPTION 'An employee has a due approved holiday entitlement without a native settlement line; recalculate before committing.';
  END IF;
  UPDATE public.pay_run_holiday_allocations SET status='committed',updated_at=now(),updated_by=coalesce(NEW.updated_by,updated_by)
    WHERE org_id=NEW.org_id AND pay_run_document_id=NEW.document_id AND status='calculated';
 ELSIF NEW.run_status='voided' AND OLD.run_status='committed' THEN
  UPDATE public.pay_run_holiday_allocations SET status='voided',updated_at=now(),updated_by=coalesce(NEW.updated_by,updated_by)
    WHERE org_id=NEW.org_id AND pay_run_document_id=NEW.document_id AND status='committed';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_holiday_run_transition BEFORE UPDATE ON public.pay_runs
 FOR EACH ROW EXECUTE FUNCTION public.payroll_holiday_run_transition();

CREATE FUNCTION public.payroll_holiday_allocation_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 IF TG_OP='DELETE' THEN
  INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
  VALUES(OLD.org_id,'pay_run_holiday_allocations',OLD.id,'delete',jsonb_build_object('before',to_jsonb(OLD)),OLD.updated_by);
  RETURN OLD;
 END IF;
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
 VALUES(NEW.org_id,'pay_run_holiday_allocations',NEW.id,lower(TG_OP),jsonb_build_object('before',CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,'after',to_jsonb(NEW)),NEW.updated_by);
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_holiday_allocation_audit AFTER INSERT OR UPDATE OR DELETE ON public.pay_run_holiday_allocations
 FOR EACH ROW EXECUTE FUNCTION public.payroll_holiday_allocation_audit();
ALTER TABLE public.pay_run_holiday_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_run_holiday_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.pay_run_holiday_allocations
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.pay_run_holiday_allocations IS 'openbooks:org_isolation:v1';
SELECT public.openbooks_refresh_query_catalog();
