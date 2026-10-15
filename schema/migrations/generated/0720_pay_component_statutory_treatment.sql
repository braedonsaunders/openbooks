-- Contribution-program, employer-levy and vacation-base treatment can
-- change over time. Keep one effective-dated source and retain the version
-- resolved by each payroll calculation.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE public.pay_component_statutory_treatments (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  pay_component_id uuid NOT NULL,
  worker_comp_group_id uuid,
  effective_from date NOT NULL,
  effective_to date,
  program_exclusions text[] DEFAULT '{}'::text[] NOT NULL,
  vacationable boolean NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT pay_component_statutory_treatments_pkey PRIMARY KEY (id),
  CONSTRAINT pay_component_statutory_treatments_component_fkey
    FOREIGN KEY (org_id, pay_component_id)
    REFERENCES public.pay_components (org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT pay_component_statutory_treatments_worker_comp_group_fkey
    FOREIGN KEY (org_id, worker_comp_group_id)
    REFERENCES public.worker_comp_groups (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT pay_component_statutory_treatments_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT pay_component_statutory_treatments_effective_pair
    CHECK (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT pay_component_statutory_treatments_keys
    CHECK (array_position(program_exclusions, NULL) IS NULL),
  CONSTRAINT pay_component_statutory_treatments_default_range_exclusion
    EXCLUDE USING gist (
      org_id WITH =,
      pay_component_id WITH =,
      (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
    ) WHERE (worker_comp_group_id IS NULL),
  CONSTRAINT pay_component_statutory_treatments_group_range_exclusion
    EXCLUDE USING gist (
      org_id WITH =,
      pay_component_id WITH =,
      worker_comp_group_id WITH =,
      (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
    ) WHERE (worker_comp_group_id IS NOT NULL)
);

CREATE INDEX pay_component_statutory_treatments_component
  ON public.pay_component_statutory_treatments (org_id, pay_component_id, worker_comp_group_id);

-- An explicit dated worker-compensation assignment may declare that no group
-- applies. The dated row then suppresses fallback to the employee's live role.
ALTER TABLE public.payroll_employee_employer_assignments
  DROP CONSTRAINT payroll_employee_employer_assignments_check1;
ALTER TABLE public.payroll_employee_employer_assignments
  ADD CONSTRAINT payroll_employee_employer_assignments_assignment_shape
  CHECK ((assignment_kind = 'filing_account' AND filing_account_id IS NOT NULL AND worker_comp_group_id IS NULL)
      OR (assignment_kind = 'worker_comp' AND filing_account_id IS NULL));

-- One selector gives explicit dated absence precedence over live classification.
CREATE FUNCTION public.payroll_worker_comp_group_at(organization_id uuid, employee_id uuid, pay_date date)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE WHEN dated.id IS NOT NULL THEN dated.worker_comp_group_id
              ELSE current_group.worker_comp_group_id END
    FROM (SELECT 1) subject
    LEFT JOIN LATERAL (
      SELECT assignment.id, assignment.worker_comp_group_id
        FROM public.payroll_employee_employer_assignments assignment
       WHERE assignment.org_id = organization_id AND assignment.employee_party_id = employee_id
         AND assignment.assignment_kind = 'worker_comp'
         AND pay_date BETWEEN assignment.effective_from AND assignment.effective_to
       ORDER BY assignment.effective_from DESC, assignment.id LIMIT 1
    ) dated ON true
    LEFT JOIN LATERAL (
      SELECT role.worker_comp_group_id
        FROM public.employee_roles role
        JOIN public.worker_comp_groups worker_group
          ON worker_group.org_id = role.org_id AND worker_group.id = role.worker_comp_group_id
         AND worker_group.is_active
       WHERE role.org_id = organization_id AND role.party_id = employee_id AND role.is_active
         AND dated.id IS NULL
       ORDER BY role.updated_at DESC, role.id LIMIT 1
    ) current_group ON true
$function$;

CREATE OR REPLACE FUNCTION public.payroll_employee_employer_assignment_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE employee_employer uuid; employee_country text; current_id uuid;
BEGIN
 IF TG_OP='DELETE' AND (public.openbooks_sandbox_wipe_allowed(OLD.org_id)
   OR tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() AND TG_OP<>'DELETE' THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'Dated employer assignment evidence is immutable; retain the record and use a controlled payroll correction.';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id||':'||NEW.employee_party_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id||':'||NEW.employee_party_id||':'||NEW.tax_year,0));
 SELECT p.subsidiary_id,prof.country,prof.filing_account_id INTO employee_employer,employee_country,current_id
  FROM public.employee_payroll_profiles prof JOIN public.parties p ON p.org_id=prof.org_id AND p.id=prof.employee_party_id
  WHERE prof.org_id=NEW.org_id AND prof.employee_party_id=NEW.employee_party_id FOR UPDATE OF prof FOR SHARE OF p;
 IF NOT FOUND OR employee_employer IS DISTINCT FROM NEW.subsidiary_id THEN
  RAISE EXCEPTION 'Choose the saved payroll employee and their own legal employer before recording an assignment.';
 END IF;
 IF NEW.assignment_kind='filing_account' THEN
  PERFORM a.id FROM public.payroll_filing_accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.filing_account_id
    AND a.country=employee_country AND (a.subsidiary_id IS NULL OR a.subsidiary_id=employee_employer) AND a.is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active filing account for the employee payroll country.'; END IF;
 ELSE
  PERFORM er.id FROM public.employee_roles er
   WHERE er.org_id=NEW.org_id AND er.party_id=NEW.employee_party_id AND er.is_active
   ORDER BY er.updated_at DESC,er.id LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Save an active employee role before recording a dated classification.'; END IF;
  current_id := public.payroll_worker_comp_group_at(NEW.org_id, NEW.employee_party_id, current_date);
  IF NEW.worker_comp_group_id IS NOT NULL THEN
   PERFORM g.id FROM public.worker_comp_groups g WHERE g.org_id=NEW.org_id AND g.id=NEW.worker_comp_group_id AND g.is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active worker-compensation group for this dated classification.'; END IF;
  END IF;
 END IF;
 IF current_id IS DISTINCT FROM NEW.expected_current_id THEN
  RAISE EXCEPTION 'The current employer assignment changed; export and preview the dated assignment again.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.pay_runs r JOIN public.pay_stubs s ON s.org_id=r.org_id AND s.pay_run_document_id=r.document_id
   JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
   WHERE r.org_id=NEW.org_id AND s.employee_party_id=NEW.employee_party_id AND r.run_status='committed' AND d.status<>'voided'
     AND r.pay_date BETWEEN NEW.effective_from AND NEW.effective_to) THEN
  RAISE EXCEPTION 'Committed payroll already used these dates; preserve its evidence and use a controlled correction run.';
 END IF;
 UPDATE public.employee_payroll_profiles SET updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond'),updated_by=NEW.created_by
  WHERE org_id=NEW.org_id AND employee_party_id=NEW.employee_party_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'The payroll profile revision was not saved; reload the employee and preview again.'; END IF;
 RETURN NEW;
END
$function$;

ALTER TABLE ONLY public.pay_component_statutory_treatments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.pay_component_statutory_treatments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.pay_component_statutory_treatments
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.pay_component_statutory_treatments
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE FUNCTION public.pay_component_statutory_treatment_clone_matches(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target record;
  original jsonb;
  expected jsonb;
  column_row record;
BEGIN
  IF NOT public.openbooks_clone_authority() THEN RETURN false; END IF;
  SELECT org.sandbox_of, org.sandbox_seed
    INTO target
    FROM public.orgs org
    JOIN public.sandboxes sandbox
      ON sandbox.org_id = org.id AND sandbox.production_org_id = org.sandbox_of
   WHERE org.id = (candidate->>'org_id')::uuid
     AND org.env_kind = 'sandbox'
     AND org.sandbox_seed IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT to_jsonb(source)
    INTO original
    FROM public.pay_component_statutory_treatments source
   WHERE source.org_id = target.sandbox_of
     AND public.ob_rebase(source.id, target.sandbox_seed) = (candidate->>'id')::uuid;
  IF original IS NULL THEN RETURN false; END IF;

  expected := original;
  FOR column_row IN
    SELECT attribute.attname, attribute.atttypid
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = 'public.pay_component_statutory_treatments'::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
  LOOP
    IF column_row.attname = 'org_id' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb((candidate->>'org_id')::uuid));
    ELSIF column_row.atttypid = 'uuid'::regtype
      AND jsonb_typeof(original->column_row.attname) = 'string' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb(public.ob_rebase(
        (original->>column_row.attname)::uuid, target.sandbox_seed
      )));
    END IF;
  END LOOP;
  RETURN candidate = expected;
END
$function$;

-- Published calculations bind the version that fed their statutory lines.
-- A policy row used by a committed run may be closed after its last committed
-- pay date, but its component and policy values remain part of that proof.
CREATE FUNCTION public.pay_component_statutory_treatment_preserve_committed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  last_committed_pay_date date;
  parent_component record;
BEGIN
  IF TG_OP = 'INSERT'
     AND public.pay_component_statutory_treatment_clone_matches(to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND (
    tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)
  ) THEN
    RETURN OLD;
  END IF;

  -- Serialize treatment changes with payroll calculations that share-lock
  -- the parent component before resolving this policy.
  FOR parent_component IN
    SELECT DISTINCT changed.org_id, changed.pay_component_id
      FROM (VALUES
        (CASE WHEN TG_OP <> 'INSERT' THEN OLD.org_id END,
         CASE WHEN TG_OP <> 'INSERT' THEN OLD.pay_component_id END),
        (CASE WHEN TG_OP <> 'DELETE' THEN NEW.org_id END,
         CASE WHEN TG_OP <> 'DELETE' THEN NEW.pay_component_id END)
      ) AS changed(org_id, pay_component_id)
     WHERE changed.org_id IS NOT NULL AND changed.pay_component_id IS NOT NULL
     ORDER BY changed.org_id, changed.pay_component_id
  LOOP
    PERFORM component.id
      FROM public.pay_components component
     WHERE component.org_id = parent_component.org_id
       AND component.id = parent_component.pay_component_id
     FOR UPDATE;
  END LOOP;

  IF TG_OP = 'INSERT' THEN
    SELECT max(r.pay_date)
      INTO last_committed_pay_date
      FROM public.pay_runs r
      JOIN public.pay_stubs stub
        ON stub.org_id = r.org_id AND stub.pay_run_document_id = r.document_id
      JOIN public.pay_stub_lines line
        ON line.org_id = stub.org_id AND line.stub_id = stub.id
     WHERE r.org_id = NEW.org_id
       AND r.run_status = 'committed'
       AND r.pay_date >= NEW.effective_from
       AND (NEW.effective_to IS NULL OR r.pay_date <= NEW.effective_to)
       AND line.kind = 'earning'
       AND line.component_id = NEW.pay_component_id
       AND (NEW.worker_comp_group_id IS NULL OR NEW.worker_comp_group_id IS NOT DISTINCT FROM
         public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date));

    IF last_committed_pay_date IS NOT NULL THEN
      RAISE EXCEPTION 'a statutory treatment cannot be added over a committed payroll calculation'
        USING ERRCODE = '23514', CONSTRAINT = 'pay_component_statutory_treatment_committed_history';
    END IF;
    RETURN NEW;
  END IF;

  SELECT max(r.pay_date)
    INTO last_committed_pay_date
    FROM public.pay_runs r
   WHERE r.org_id = OLD.org_id
     AND r.run_status = 'committed'
     AND r.pay_date >= OLD.effective_from
     AND (OLD.effective_to IS NULL OR r.pay_date <= OLD.effective_to)
     AND EXISTS (
         SELECT 1
           FROM public.pay_stubs stub
           JOIN public.pay_stub_lines line
             ON line.org_id = stub.org_id AND line.stub_id = stub.id
          WHERE stub.org_id = r.org_id
            AND stub.pay_run_document_id = r.document_id
            AND line.kind = 'earning'
            AND line.component_id = OLD.pay_component_id
       AND (
         coalesce(r.calculation_source_snapshot, '{}'::jsonb) @> jsonb_build_object(
           'payComponentStatutoryTreatments', jsonb_build_array(jsonb_build_object('id', OLD.id))
         )
         OR coalesce(r.calculation_source_snapshot, '{}'::jsonb) @> jsonb_build_object(
           'payComponentStatutoryTreatments', jsonb_build_array(jsonb_build_object(
             'componentId', OLD.pay_component_id::text,
             'workerCompGroupId', OLD.worker_comp_group_id::text,
             'effectiveFrom', OLD.effective_from::text,
             'effectiveTo', OLD.effective_to::text,
             'programExclusions', OLD.program_exclusions
           ))
         )
         OR EXISTS (
           SELECT 1
             FROM public.orgs clone_org
             JOIN public.sandboxes sandbox ON sandbox.org_id = clone_org.id
              AND sandbox.production_org_id = clone_org.sandbox_of
             CROSS JOIN LATERAL jsonb_array_elements(
               coalesce(r.calculation_source_snapshot->'payComponentStatutoryTreatments', '[]'::jsonb)
             ) consumed
            WHERE clone_org.id = OLD.org_id AND clone_org.env_kind = 'sandbox'
              AND clone_org.sandbox_seed IS NOT NULL
              AND public.ob_rebase((consumed->>'id')::uuid, clone_org.sandbox_seed) = OLD.id
              AND public.ob_rebase((consumed->>'componentId')::uuid, clone_org.sandbox_seed) = OLD.pay_component_id
              AND public.ob_rebase((consumed->>'workerCompGroupId')::uuid, clone_org.sandbox_seed)
                IS NOT DISTINCT FROM OLD.worker_comp_group_id
         )
         OR (
           NOT (coalesce(r.calculation_source_snapshot, '{}'::jsonb) ? 'payComponentStatutoryTreatments')
           AND r.pay_date >= OLD.effective_from
           AND (OLD.effective_to IS NULL OR r.pay_date <= OLD.effective_to)
           AND (OLD.worker_comp_group_id IS NULL OR OLD.worker_comp_group_id IS NOT DISTINCT FROM
             public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))
         )
       )
     );

  IF last_committed_pay_date IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a statutory treatment used by a committed payroll calculation cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'pay_component_statutory_treatment_committed_history';
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.pay_component_id IS DISTINCT FROM OLD.pay_component_id
     OR NEW.worker_comp_group_id IS DISTINCT FROM OLD.worker_comp_group_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.program_exclusions IS DISTINCT FROM OLD.program_exclusions
     OR NEW.vacationable IS DISTINCT FROM OLD.vacationable
     OR (NEW.effective_to IS NOT NULL AND NEW.effective_to < last_committed_pay_date) THEN
    RAISE EXCEPTION 'a statutory treatment used by a committed payroll calculation cannot be changed over committed history'
      USING ERRCODE = '23514', CONSTRAINT = 'pay_component_statutory_treatment_committed_history';
  END IF;
  RETURN NEW;
END
$function$;

-- Move the legacy open-ended choice intact. Newly seeded components then use
-- this table as their sole assessability and vacation-base policy source.
INSERT INTO public.pay_component_statutory_treatments
  (org_id, pay_component_id, worker_comp_group_id, effective_from, effective_to, program_exclusions, vacationable,
   created_at, created_by, updated_at, updated_by)
SELECT org_id, id, NULL, DATE '0001-01-01', NULL, program_exclusions, vacationable,
       created_at, created_by, updated_at, updated_by
  FROM public.pay_components;

-- Install the history guard only after the pre-existing static choices have
-- been copied into their version rows.
CREATE TRIGGER pay_component_statutory_treatment_preserve_committed
  BEFORE INSERT OR UPDATE OR DELETE ON public.pay_component_statutory_treatments
  FOR EACH ROW EXECUTE FUNCTION public.pay_component_statutory_treatment_preserve_committed();

-- The component flag supplies only the first dated treatment at creation.
-- Existing components change vacation-base policy through dated Setup history.
CREATE FUNCTION public.pay_component_vacation_creation_default_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.vacationable IS DISTINCT FROM OLD.vacationable THEN
    RAISE EXCEPTION 'The component vacation flag is a creation-only default; change vacation-base inclusion through a dated component statutory treatment in Payroll Setup.'
      USING ERRCODE = '23514', CONSTRAINT = 'pay_component_vacation_creation_default';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER pay_component_vacation_creation_default_guard
  BEFORE UPDATE OF vacationable ON public.pay_components
  FOR EACH ROW EXECUTE FUNCTION public.pay_component_vacation_creation_default_guard();
COMMENT ON COLUMN public.pay_components.vacationable IS
  'Creation-only initial vacation-base default. Payroll resolves vacation-base inclusion from pay_component_statutory_treatments at pay date.';
COMMENT ON COLUMN public.pay_component_statutory_treatments.vacationable IS
  'Whether the earning enters vacation and bankable earnings bases at payroll pay date; the selected group override governs the entire treatment.';

-- The governed view freezes SELECT * at creation and still references the
-- static column. Remove only that view before retiring the column; the native
-- catalog refresh below restores its tenant filter, security barrier and grants.
-- RESTRICT preserves any unexpected dependent objects for explicit review.
DROP VIEW IF EXISTS openbooks_query.pay_components RESTRICT;
ALTER TABLE public.pay_components DROP COLUMN program_exclusions;

COMMENT ON TABLE public.pay_component_statutory_treatments IS
  'Effective-dated contribution-program and employer-levy exclusions and vacation-base inclusion at payroll pay date for a pay component. A workers-compensation-group row overrides the component-wide row; payroll retains the resolved identity and values in calculation evidence.';
COMMENT ON CONSTRAINT pay_component_statutory_treatments_default_range_exclusion
  ON public.pay_component_statutory_treatments IS
  'One component-wide statutory treatment may cover each date; inclusive windows may not overlap.';
COMMENT ON CONSTRAINT pay_component_statutory_treatments_group_range_exclusion
  ON public.pay_component_statutory_treatments IS
  'One statutory treatment per organization, component and workers-compensation group may cover each date; inclusive windows may not overlap.';

INSERT INTO public.openbooks_query_catalog_relations(relation, added_in)
  VALUES ('pay_component_statutory_treatments', '0720_pay_component_statutory_treatment');
SELECT public.openbooks_refresh_query_catalog();
