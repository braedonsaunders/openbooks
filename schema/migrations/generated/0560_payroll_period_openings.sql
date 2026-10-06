-- Attribute previously paid period amounts within the existing annual carry-in.
-- These records provide statutory inputs without creating another payroll payment.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE UNIQUE INDEX payroll_opening_balances_period_reference
 ON public.payroll_opening_balances(org_id, employee_party_id, tax_year, id);
CREATE UNIQUE INDEX pay_schedules_period_opening_reference ON public.pay_schedules(org_id, id);
CREATE TABLE public.payroll_period_openings (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 employee_party_id uuid NOT NULL, annual_opening_balance_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL, pay_schedule_id uuid NOT NULL,
 country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'), currency text NOT NULL REFERENCES public.currencies(code) CHECK(currency ~ '^[A-Z]{3}$'),
 tax_year integer NOT NULL CHECK(tax_year BETWEEN 2000 AND 2100),
 period_start date NOT NULL, period_end date NOT NULL, paid_through date NOT NULL,
 amounts jsonb NOT NULL CHECK(jsonb_typeof(amounts)='object' AND amounts<>'{}'::jsonb),
 annual_bounds jsonb NOT NULL CHECK(jsonb_typeof(annual_bounds)='object' AND annual_bounds<>'{}'::jsonb),
 contract_hash text NOT NULL CHECK(contract_hash ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 source_reference text NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 2000),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id, id), UNIQUE(org_id, employee_party_id, tax_year),
 FOREIGN KEY(org_id, employee_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY(org_id, employee_party_id, tax_year, annual_opening_balance_id)
  REFERENCES public.payroll_opening_balances(org_id, employee_party_id, tax_year, id),
 FOREIGN KEY(org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY(org_id, pay_schedule_id) REFERENCES public.pay_schedules(org_id, id),
 FOREIGN KEY(org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY(org_id, updated_by) REFERENCES public.users(org_id, id),
 CHECK(period_start BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' AND period_end>=period_start),
 CHECK(paid_through>=period_end)
);

CREATE FUNCTION public.payroll_period_opening_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE opening jsonb; amount record; annual_amount numeric; v_org uuid; v_employee uuid; v_year integer;
BEGIN
 v_org:=CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 v_employee:=CASE WHEN TG_OP='DELETE' THEN OLD.employee_party_id ELSE NEW.employee_party_id END;
 v_year:=CASE WHEN TG_OP='DELETE' THEN OLD.tax_year ELSE NEW.tax_year END;
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(v_org) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Period openings preserve source history; correct an unused opening with an audited revision.'; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 THEN RAISE EXCEPTION 'A new period opening must begin at revision one.'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||v_org||':'||v_employee,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||v_org||':'||v_employee||':'||v_year,0));
 IF EXISTS(SELECT 1 FROM public.pay_stubs s JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id
  WHERE s.org_id=v_org AND s.employee_party_id=v_employee AND s.tax_year=v_year AND r.run_status='committed') THEN
  RAISE EXCEPTION 'A committed payroll already used this employee year; reverse the affected payroll through its controlled void action before correcting opening balances.';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.org_id,NEW.id,NEW.employee_party_id,NEW.tax_year,NEW.annual_opening_balance_id,NEW.created_at,NEW.created_by)
   IS DISTINCT FROM ROW(OLD.org_id,OLD.id,OLD.employee_party_id,OLD.tax_year,OLD.annual_opening_balance_id,OLD.created_at,OLD.created_by) THEN
   RAISE EXCEPTION 'Period opening ownership and creation evidence are immutable.';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'The period opening changed; reload its current revision before saving.'; END IF;
 END IF;
 SELECT to_jsonb(b) INTO opening FROM public.payroll_opening_balances b
  WHERE b.org_id=NEW.org_id AND b.id=NEW.annual_opening_balance_id
   AND b.employee_party_id=NEW.employee_party_id AND b.tax_year=NEW.tax_year FOR SHARE;
 IF opening IS NULL THEN RAISE EXCEPTION 'Record the verified annual payroll opening balances before attributing same-period payments.'; END IF;
 FOR amount IN SELECT key,value FROM jsonb_each_text(NEW.amounts) LOOP
  IF amount.key !~ '^[A-Za-z][A-Za-z0-9_]*$' OR amount.value !~ '^[0-9]{1,15}\.[0-9]{4}$' THEN
   RAISE EXCEPTION 'Period opening amounts must be non-negative exact decimal text.';
  END IF;
 END LOOP;
 FOR amount IN SELECT key,value FROM jsonb_each_text(NEW.annual_bounds) LOOP
  IF amount.value !~ '^[0-9]{1,15}\.[0-9]{4}$' THEN
   RAISE EXCEPTION 'Annual period bounds must use exact non-negative decimal text.';
  END IF;
  IF amount.key ~ '^program:[A-Za-z][A-Za-z0-9_]*$' THEN
   SELECT coalesce(sum(insurable_ytd),0) INTO annual_amount FROM public.payroll_opening_program_bases
    WHERE org_id=NEW.org_id AND employee_party_id=NEW.employee_party_id AND tax_year=NEW.tax_year
     AND program_key=substring(amount.key FROM 9);
  ELSIF amount.key ~ '^[a-z][a-z0-9_]*$' AND jsonb_typeof(opening->amount.key)='number' THEN
   annual_amount:=(opening->>amount.key)::numeric;
  ELSE
   RAISE EXCEPTION 'The period opening names an unavailable annual balance.';
  END IF;
  IF amount.value::numeric>annual_amount THEN
   RAISE EXCEPTION 'Period amounts must already be included in their annual payroll opening balances; review annual and period amounts together.';
  END IF;
 END LOOP;
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_period_opening_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_period_openings
 FOR EACH ROW EXECUTE FUNCTION public.payroll_period_opening_guard();

CREATE FUNCTION public.payroll_period_opening_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
 VALUES(NEW.org_id,'payroll_period_openings',NEW.id,lower(TG_OP),CASE WHEN public.openbooks_clone_authority() THEN NULL ELSE NEW.updated_by END,
 jsonb_build_object('before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,'after',to_jsonb(NEW),
   'reason',CASE WHEN public.openbooks_clone_authority() THEN 'Preserve period opening evidence during controlled sandbox cloning.' ELSE NEW.reason END,'sourceReference',NEW.source_reference));
 -- Identity rebasing preserves the copied parent version and financial facts.
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 -- Native readiness already watches the parent annual opening. Keep every
 -- period revision inside that same employee/year source and commit fence.
 UPDATE public.payroll_opening_balances SET updated_by=NEW.updated_by,
  updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
  WHERE org_id=NEW.org_id AND id=NEW.annual_opening_balance_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'The annual opening is unavailable; reload opening balances before saving.'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_period_opening_audit AFTER INSERT OR UPDATE ON public.payroll_period_openings
 FOR EACH ROW EXECUTE FUNCTION public.payroll_period_opening_audit();

CREATE FUNCTION public.payroll_annual_period_bounds_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE period_opening record; amount record;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 FOR period_opening IN SELECT annual_bounds FROM public.payroll_period_openings
  WHERE org_id=OLD.org_id AND annual_opening_balance_id=OLD.id LOOP
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Annual balances referenced by same-period payments must be retained; save explicit zero balances after clearing the unused period amounts.';
  END IF;
  FOR amount IN SELECT key,value FROM jsonb_each_text(period_opening.annual_bounds) LOOP
   IF amount.key LIKE 'program:%' THEN CONTINUE; END IF;
   IF (to_jsonb(NEW)->amount.key) IS NULL OR (to_jsonb(NEW)->>amount.key)::numeric<amount.value::numeric THEN
    RAISE EXCEPTION 'Annual opening balances cannot be reduced below their admitted period payments; correct the unused period amounts first.';
   END IF;
  END LOOP;
 END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $function$;
CREATE TRIGGER payroll_annual_period_bounds_guard BEFORE UPDATE OR DELETE ON public.payroll_opening_balances
 FOR EACH ROW EXECUTE FUNCTION public.payroll_annual_period_bounds_guard();

-- The annual writer replaces program rows within one transaction. Check the
-- finished set, so a faithful replacement does not fail during its delete step.
CREATE FUNCTION public.payroll_program_period_bounds_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE subjects jsonb; subject record; bound numeric; annual_amount numeric;
BEGIN
 subjects:=CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW))
  WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END;
 IF TG_WHEN='BEFORE' THEN
  -- Direct program corrections use the same ordering as annual entry and
  -- payroll commit, before the changed amounts become visible.
  FOR subject IN SELECT DISTINCT org_id,employee_party_id FROM jsonb_to_recordset(subjects)
   AS r(org_id uuid,employee_party_id uuid) ORDER BY org_id,employee_party_id LOOP
   IF NOT public.openbooks_sandbox_wipe_allowed(subject.org_id) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||subject.org_id||':'||subject.employee_party_id,0));
   END IF;
  END LOOP;
  FOR subject IN SELECT DISTINCT org_id,employee_party_id,tax_year FROM jsonb_to_recordset(subjects)
   AS r(org_id uuid,employee_party_id uuid,tax_year integer) ORDER BY org_id,employee_party_id,tax_year LOOP
   IF NOT public.openbooks_sandbox_wipe_allowed(subject.org_id) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||subject.org_id||':'||subject.employee_party_id||':'||subject.tax_year,0));
   END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END IF;
 -- A reassignment must also preserve the old subject's admitted share.
 FOR subject IN SELECT DISTINCT org_id,employee_party_id,tax_year,program_key FROM jsonb_to_recordset(subjects)
  AS r(org_id uuid,employee_party_id uuid,tax_year integer,program_key text) LOOP
  IF public.openbooks_sandbox_wipe_allowed(subject.org_id) THEN CONTINUE; END IF;
  SELECT (annual_bounds->>('program:'||subject.program_key))::numeric INTO bound FROM public.payroll_period_openings
   WHERE org_id=subject.org_id AND employee_party_id=subject.employee_party_id AND tax_year=subject.tax_year;
  IF bound IS NOT NULL THEN
   SELECT coalesce(sum(insurable_ytd),0) INTO annual_amount FROM public.payroll_opening_program_bases
    WHERE org_id=subject.org_id AND employee_party_id=subject.employee_party_id AND tax_year=subject.tax_year AND program_key=subject.program_key;
   IF annual_amount<bound THEN RAISE EXCEPTION 'Annual contribution-program balances cannot be reduced below their admitted period payments; correct the unused period amounts first.'; END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END $function$;
CREATE TRIGGER payroll_program_period_bounds_fence BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_program_bases
 FOR EACH ROW EXECUTE FUNCTION public.payroll_program_period_bounds_guard();
CREATE CONSTRAINT TRIGGER payroll_program_period_bounds_guard AFTER INSERT OR UPDATE OR DELETE ON public.payroll_opening_program_bases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_program_period_bounds_guard();

ALTER TABLE public.payroll_period_openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_period_openings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_period_openings
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.payroll_period_openings IS 'openbooks:org_isolation:v1';
SELECT public.openbooks_refresh_query_catalog();
