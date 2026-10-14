-- Contribution-program and employer-levy assessability is a policy that can
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

ALTER TABLE ONLY public.pay_component_statutory_treatments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.pay_component_statutory_treatments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.pay_component_statutory_treatments
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true));

-- Published calculations bind the version that fed their statutory lines.
-- A policy row used by a committed run may be closed after its last committed
-- pay date, but its component and exclusions remain part of that proof.
CREATE FUNCTION public.pay_component_statutory_treatment_preserve_committed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  last_committed_pay_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT max(r.pay_date)
      INTO last_committed_pay_date
      FROM public.pay_runs r
      JOIN public.pay_stubs stub
        ON stub.org_id = r.org_id AND stub.pay_run_document_id = r.document_id
      JOIN public.pay_stub_lines line
        ON line.org_id = stub.org_id AND line.stub_id = stub.id
      LEFT JOIN LATERAL (
        SELECT assignment.id, assignment.worker_comp_group_id
          FROM public.payroll_employee_employer_assignments assignment
         WHERE assignment.org_id = stub.org_id
           AND assignment.employee_party_id = stub.employee_party_id
           AND assignment.assignment_kind = 'worker_comp'
           AND r.pay_date BETWEEN assignment.effective_from AND assignment.effective_to
         ORDER BY assignment.effective_from DESC, assignment.id
         LIMIT 1
      ) dated_group ON true
      LEFT JOIN LATERAL (
        SELECT role.worker_comp_group_id
          FROM public.employee_roles role
          JOIN public.worker_comp_groups worker_group
            ON worker_group.org_id = role.org_id
           AND worker_group.id = role.worker_comp_group_id
           AND worker_group.is_active
         WHERE role.org_id = stub.org_id
           AND role.party_id = stub.employee_party_id
           AND role.is_active
         ORDER BY role.updated_at DESC, role.id
         LIMIT 1
      ) current_group ON true
     WHERE r.org_id = NEW.org_id
       AND r.run_status = 'committed'
       AND r.pay_date >= NEW.effective_from
       AND (NEW.effective_to IS NULL OR r.pay_date <= NEW.effective_to)
       AND line.kind = 'earning'
       AND line.component_id = NEW.pay_component_id
       AND (NEW.worker_comp_group_id IS NULL OR NEW.worker_comp_group_id IS NOT DISTINCT FROM
         CASE WHEN dated_group.id IS NOT NULL THEN dated_group.worker_comp_group_id
              ELSE current_group.worker_comp_group_id END);

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
     AND (
       coalesce(r.calculation_source_snapshot, '{}'::jsonb) @> jsonb_build_object(
         'payComponentStatutoryTreatments', jsonb_build_array(jsonb_build_object('id', OLD.id))
       )
       OR NOT (coalesce(r.calculation_source_snapshot, '{}'::jsonb) ? 'payComponentStatutoryTreatments')
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
              OLD.worker_comp_group_id IS NULL
              OR OLD.worker_comp_group_id IS NOT DISTINCT FROM (
                SELECT assignment.worker_comp_group_id
                  FROM public.payroll_employee_employer_assignments assignment
                 WHERE assignment.org_id = stub.org_id
                   AND assignment.employee_party_id = stub.employee_party_id
                   AND assignment.assignment_kind = 'worker_comp'
                   AND r.pay_date BETWEEN assignment.effective_from AND assignment.effective_to
                 ORDER BY assignment.effective_from DESC, assignment.id
                 LIMIT 1
              )
              OR OLD.worker_comp_group_id IS NOT DISTINCT FROM (
                SELECT role.worker_comp_group_id
                  FROM public.employee_roles role
                  JOIN public.worker_comp_groups worker_group
                    ON worker_group.org_id = role.org_id
                   AND worker_group.id = role.worker_comp_group_id
                   AND worker_group.is_active
                 WHERE role.org_id = stub.org_id
                   AND role.party_id = stub.employee_party_id
                   AND role.is_active
                   AND NOT EXISTS (
                     SELECT 1
                       FROM public.payroll_employee_employer_assignments assignment
                      WHERE assignment.org_id = stub.org_id
                        AND assignment.employee_party_id = stub.employee_party_id
                        AND assignment.assignment_kind = 'worker_comp'
                        AND r.pay_date BETWEEN assignment.effective_from AND assignment.effective_to
                   )
                 ORDER BY role.updated_at DESC, role.id
                 LIMIT 1
              )
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
     OR (NEW.effective_to IS NOT NULL AND NEW.effective_to < last_committed_pay_date) THEN
    RAISE EXCEPTION 'a statutory treatment used by a committed payroll calculation cannot be changed over committed history'
      USING ERRCODE = '23514', CONSTRAINT = 'pay_component_statutory_treatment_committed_history';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER pay_component_statutory_treatment_preserve_committed
  BEFORE INSERT OR UPDATE OR DELETE ON public.pay_component_statutory_treatments
  FOR EACH ROW EXECUTE FUNCTION public.pay_component_statutory_treatment_preserve_committed();

-- Move the legacy open-ended choice intact. Newly seeded components then use
-- this table as their sole assessability source.
INSERT INTO public.pay_component_statutory_treatments
  (org_id, pay_component_id, worker_comp_group_id, effective_from, effective_to, program_exclusions,
   created_at, created_by, updated_at, updated_by)
SELECT org_id, id, NULL, DATE '0001-01-01', NULL, program_exclusions,
       created_at, created_by, updated_at, updated_by
  FROM public.pay_components;

ALTER TABLE public.pay_components DROP COLUMN program_exclusions;

COMMENT ON TABLE public.pay_component_statutory_treatments IS
  'Effective-dated contribution-program and employer-levy exclusions for a pay component. A workers-compensation-group row overrides the component-wide row; payroll retains the resolved identity and values in calculation evidence.';
COMMENT ON CONSTRAINT pay_component_statutory_treatments_default_range_exclusion
  ON public.pay_component_statutory_treatments IS
  'One component-wide statutory treatment may cover each date; inclusive windows may not overlap.';
COMMENT ON CONSTRAINT pay_component_statutory_treatments_group_range_exclusion
  ON public.pay_component_statutory_treatments IS
  'One statutory treatment per organization, component and workers-compensation group may cover each date; inclusive windows may not overlap.';

SELECT public.openbooks_refresh_query_catalog();
