-- Retain independently approved unpaid holiday entitlements separately from worked time.
DO $block$ DECLARE domain_constraint text; BEGIN
 SELECT conname INTO STRICT domain_constraint FROM pg_constraint
  WHERE conrelid='public.financial_changes'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%lease%revenue%asset%consolidation%manufacturing%provision%sales%';
 EXECUTE format('ALTER TABLE public.financial_changes DROP CONSTRAINT %I',domain_constraint);
 EXECUTE format('ALTER TABLE public.financial_changes ADD CONSTRAINT %I CHECK(domain IN (''lease'',''revenue'',''asset'',''consolidation'',''manufacturing'',''provision'',''sales'',''payroll''))',domain_constraint);
END $block$;

CREATE UNIQUE INDEX file_versions_file_identity ON public.file_versions(file_id,id);

CREATE TABLE public.payroll_holiday_obligations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 change_id uuid NOT NULL, employee_party_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
 employment_id uuid NOT NULL, payment_date date NOT NULL,
 source_file_id uuid NOT NULL, source_version_id uuid NOT NULL,
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,change_id),
 UNIQUE(org_id,id,employee_party_id,subsidiary_id),
 FOREIGN KEY(org_id,change_id) REFERENCES public.financial_changes(org_id,id),
 FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
 FOREIGN KEY(org_id,source_file_id) REFERENCES public.files(org_id,id),
 FOREIGN KEY(source_file_id,source_version_id) REFERENCES public.file_versions(file_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id)
);

CREATE TABLE public.payroll_holiday_occurrences (
 org_id uuid NOT NULL, obligation_id uuid NOT NULL, employee_party_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL, holiday_date date NOT NULL,
 PRIMARY KEY(org_id,obligation_id,holiday_date),
 UNIQUE(org_id,employee_party_id,subsidiary_id,holiday_date),
 FOREIGN KEY(org_id,obligation_id,employee_party_id,subsidiary_id)
  REFERENCES public.payroll_holiday_obligations(org_id,id,employee_party_id,subsidiary_id)
);
CREATE INDEX payroll_holiday_obligations_due ON public.payroll_holiday_obligations(org_id,payment_date,employee_party_id);

CREATE FUNCTION public.payroll_holiday_obligation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE proposal public.financial_changes%ROWTYPE; obligation public.payroll_holiday_obligations%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Approved holiday entitlement evidence is immutable; preserve it and use a governed correction.';
 END IF;
 IF TG_TABLE_NAME='payroll_holiday_occurrences' THEN
  SELECT * INTO STRICT obligation FROM public.payroll_holiday_obligations WHERE org_id=NEW.org_id AND id=NEW.obligation_id FOR SHARE;
  IF NOT coalesce(obligation.evidence->'instruction'->'holidayDates' ? NEW.holiday_date::text,false) THEN
   RAISE EXCEPTION 'A holiday occurrence must be named in its approved entitlement.';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT proposal FROM public.financial_changes WHERE org_id=NEW.org_id AND id=NEW.change_id FOR SHARE;
 IF proposal.domain<>'payroll' OR proposal.operation<>'adjudicated_holiday_hours'
   OR proposal.status<>'approved' OR proposal.approved_by IS NULL OR proposal.approved_by=proposal.submitted_by
   OR proposal.subject_id IS DISTINCT FROM NEW.employee_party_id
   OR proposal.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id
   OR proposal.effective_on IS DISTINCT FROM NEW.payment_date
   OR proposal.payload->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
   OR proposal.payload->'evidence' IS DISTINCT FROM NEW.evidence
   OR proposal.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text) THEN
  RAISE EXCEPTION 'Unpaid holiday pay requires an independently approved proposal for this employee, employment, employer, payment date and exact source evidence.';
 END IF;
 IF NEW.evidence->'instruction'->>'employeePartyId' IS DISTINCT FROM NEW.employee_party_id::text
   OR NEW.evidence->'instruction'->>'paymentDate' IS DISTINCT FROM NEW.payment_date::text
   OR NEW.evidence->'source'->>'fileId' IS DISTINCT FROM NEW.source_file_id::text
   OR NEW.evidence->'source'->>'versionId' IS DISTINCT FROM NEW.source_version_id::text
   OR jsonb_typeof(NEW.evidence->'instruction'->'holidayDates') IS DISTINCT FROM 'array'
   OR NOT EXISTS(SELECT 1 FROM public.worker_employments e WHERE e.org_id=NEW.org_id AND e.id=NEW.employment_id
       AND e.worker_party_id=NEW.employee_party_id AND e.employer_subsidiary_id=NEW.subsidiary_id)
   OR NOT EXISTS(SELECT 1 FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
       WHERE f.org_id=NEW.org_id AND f.id=NEW.source_file_id AND v.id=NEW.source_version_id
         AND lower(v.content_hash)=NEW.evidence->'source'->>'contentHash'
         AND lower(v.content_hash)=NEW.evidence->'instruction'->>'sourceDigest'
         AND v.version_number::text=NEW.evidence->'source'->>'versionNumber') THEN
  RAISE EXCEPTION 'The holiday entitlement must retain its exact tenant-owned employee and File Cabinet source version.';
 END IF;
 RETURN NEW;
END $function$;

CREATE FUNCTION public.payroll_holiday_occurrence_completeness() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE obligation public.payroll_holiday_obligations%ROWTYPE; actual jsonb; target_id uuid;
BEGIN
 IF TG_TABLE_NAME='payroll_holiday_obligations' THEN target_id:=NEW.id; ELSE target_id:=NEW.obligation_id; END IF;
 SELECT * INTO obligation FROM public.payroll_holiday_obligations
  WHERE org_id=NEW.org_id AND id=target_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT jsonb_agg(holiday_date::text ORDER BY holiday_date) INTO actual FROM public.payroll_holiday_occurrences
  WHERE org_id=obligation.org_id AND obligation_id=obligation.id;
 IF actual IS DISTINCT FROM obligation.evidence->'instruction'->'holidayDates' THEN
  RAISE EXCEPTION 'Record every approved holiday occurrence exactly once before completing the entitlement.';
 END IF;
 RETURN NULL;
END $function$;

CREATE FUNCTION public.payroll_holiday_obligation_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
 VALUES(NEW.org_id,'payroll_holiday_obligations',NEW.id,'insert',jsonb_build_object('after',to_jsonb(NEW)),NEW.created_by);
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_holiday_obligation_audit AFTER INSERT ON public.payroll_holiday_obligations
 FOR EACH ROW EXECUTE FUNCTION public.payroll_holiday_obligation_audit();

DO $block$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['payroll_holiday_obligations','payroll_holiday_occurrences'] LOOP
  EXECUTE format('CREATE TRIGGER payroll_holiday_obligation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_holiday_obligation_guard()',tbl);
  EXECUTE format('CREATE CONSTRAINT TRIGGER payroll_holiday_occurrence_completeness AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_holiday_occurrence_completeness()',tbl);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true))',tbl);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''',tbl);
 END LOOP;
END $block$;
SELECT public.openbooks_refresh_query_catalog();
