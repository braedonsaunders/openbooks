-- Retain dated prior-provider wages as statutory evidence without another payment.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.payroll_prior_earnings (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 employee_party_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
 country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'),
 currency text NOT NULL REFERENCES public.currencies(code) CHECK(currency ~ '^[A-Z]{3}$'),
 history_from date NOT NULL, history_through date NOT NULL,
 periods jsonb NOT NULL CHECK(jsonb_typeof(periods)='array' AND jsonb_array_length(periods) BETWEEN 1 AND 367),
 source_file_id uuid NOT NULL REFERENCES public.files(id), source_version_id uuid NOT NULL,
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 source_reference text NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 2000),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,employee_party_id,subsidiary_id),
 FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(source_file_id,source_version_id) REFERENCES public.file_versions(file_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 CHECK(history_from>=DATE '1900-01-01' AND history_through>=history_from AND history_through-history_from<=366)
);

CREATE FUNCTION public.payroll_prior_earnings_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE source_period jsonb; earning jsonb; next_day date; source_keys text[]:=ARRAY[]::text[];
 earning_from date; earning_through date;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Prior earnings preserve source history; correct an unused record through its audited revision.'; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id||':'||NEW.employee_party_id,0));
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.org_id,NEW.id,NEW.employee_party_id,NEW.subsidiary_id,NEW.created_at,NEW.created_by)
   IS DISTINCT FROM ROW(OLD.org_id,OLD.id,OLD.employee_party_id,OLD.subsidiary_id,OLD.created_at,OLD.created_by) THEN
   RAISE EXCEPTION 'Prior earnings ownership and creation evidence are immutable.';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Prior earnings changed; reload the current revision before saving.'; END IF;
 ELSIF NEW.revision<>1 THEN RAISE EXCEPTION 'New prior earnings must start at revision one.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.pay_stubs s JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id
  JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
  WHERE s.org_id=NEW.org_id AND s.employee_party_id=NEW.employee_party_id AND d.subsidiary_id=NEW.subsidiary_id
   AND r.run_status='committed' AND r.period_end>=CASE WHEN TG_OP='UPDATE' THEN least(NEW.history_from,OLD.history_from) ELSE NEW.history_from END) THEN
  RAISE EXCEPTION 'Committed payroll overlaps or follows these prior earnings; use the governed payroll void process before correcting its inputs.';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.parties p JOIN public.employee_roles e ON e.org_id=p.org_id AND e.party_id=p.id
  JOIN public.subsidiaries employer ON employer.org_id=p.org_id AND employer.id=p.subsidiary_id
  WHERE p.org_id=NEW.org_id AND p.id=NEW.employee_party_id AND p.subsidiary_id=NEW.subsidiary_id
   AND employer.country=NEW.country AND employer.base_currency=NEW.currency) THEN
  RAISE EXCEPTION 'Prior earnings must belong to the native employee, legal employer and payroll currency.';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.file_versions v JOIN public.files f ON f.id=v.file_id
  WHERE f.org_id=NEW.org_id AND f.id=NEW.source_file_id AND v.id=NEW.source_version_id AND v.content_hash=NEW.source_hash) THEN
  RAISE EXCEPTION 'Prior earnings require the retained tenant source-file version and its exact content hash.';
 END IF;
 next_day:=NEW.history_from;
 FOR source_period IN SELECT value FROM jsonb_array_elements(NEW.periods) LOOP
  IF jsonb_typeof(source_period)<>'object' OR source_period-ARRAY['from','through','sourceReference','lines']<>'{}'::jsonb
   OR coalesce(source_period->>'from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   OR coalesce(source_period->>'through','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   OR length(trim(coalesce(source_period->>'sourceReference',''))) NOT BETWEEN 1 AND 2000
   OR coalesce(jsonb_typeof(source_period->'lines'),'')<>'array' THEN
   RAISE EXCEPTION 'Every prior-payroll period requires dates, source evidence and an explicit earning-line set.';
  END IF;
  IF (source_period->>'from')::date<>next_day OR (source_period->>'through')::date<next_day
   OR (source_period->>'through')::date>NEW.history_through OR jsonb_array_length(source_period->'lines')>2000 THEN
   RAISE EXCEPTION 'Prior earnings periods must cover the entire history interval exactly once without gaps or overlaps.';
  END IF;
  FOR earning IN SELECT value FROM jsonb_array_elements(source_period->'lines') LOOP
   IF jsonb_typeof(earning)<>'object' OR earning-ARRAY['sourceKey','sourceLabel','earnedFrom','earnedThrough','bucket','amount']<>'{}'::jsonb
    OR length(trim(coalesce(earning->>'sourceKey',''))) NOT BETWEEN 1 AND 300
    OR length(trim(coalesce(earning->>'sourceLabel',''))) NOT BETWEEN 1 AND 160
    OR coalesce(earning->>'bucket','') NOT IN('regular','overtime','vacationPay','holidayPay')
    OR coalesce(jsonb_typeof(earning->'amount'),'')<>'string'
    OR coalesce(earning->>'amount','') !~ '^-?[0-9]{1,15}\.[0-9]{4}$'
    OR coalesce(earning->>'earnedFrom','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR coalesce(earning->>'earnedThrough','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'Prior earning lines require a unique source key, original category, dated classification and exact decimal amount.';
   END IF;
   IF earning->>'sourceKey'=ANY(source_keys) THEN RAISE EXCEPTION 'A prior earning source is repeated; duplicate copies must not count twice.'; END IF;
   source_keys:=array_append(source_keys,earning->>'sourceKey');
   earning_from:=(earning->>'earnedFrom')::date; earning_through:=(earning->>'earnedThrough')::date;
   IF earning_from<(source_period->>'from')::date OR earning_through>(source_period->>'through')::date OR earning_through<earning_from THEN
    RAISE EXCEPTION 'Prior earning dates must lie wholly within the source period; payment dates do not establish earned dates.';
   END IF;
  END LOOP;
  next_day:=(source_period->>'through')::date+1;
 END LOOP;
 IF next_day<>NEW.history_through+1 THEN RAISE EXCEPTION 'Prior earnings do not reach the declared end of history.'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_prior_earnings_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_prior_earnings
 FOR EACH ROW EXECUTE FUNCTION public.payroll_prior_earnings_guard();

CREATE FUNCTION public.payroll_prior_earnings_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
 VALUES(NEW.org_id,'payroll_prior_earnings',NEW.id,lower(TG_OP),CASE WHEN public.openbooks_clone_authority() THEN NULL ELSE NEW.updated_by END,
  jsonb_build_object('before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,'after',to_jsonb(NEW),
   'employeePartyId',NEW.employee_party_id,'subsidiaryId',NEW.subsidiary_id,'reason',NEW.reason,'sourceReference',NEW.source_reference));
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_prior_earnings_audit AFTER INSERT OR UPDATE ON public.payroll_prior_earnings
 FOR EACH ROW EXECUTE FUNCTION public.payroll_prior_earnings_audit();
ALTER TABLE public.payroll_prior_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_prior_earnings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_prior_earnings
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.payroll_prior_earnings IS 'openbooks:org_isolation:v1';
SELECT public.openbooks_refresh_query_catalog();
