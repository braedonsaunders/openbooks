-- Migration 0761: effective-dated entitlement destinations for approved HR leave inputs.
-- Banked leave never falls through to the vacation plan: each bank_in leave
-- type needs an explicit mapping to an active hours entitlement plan.
-- Backfill: approved payroll inputs inherit their leave type from the source
-- request; existing rows are retained and remain pending until recalculated.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.hrm_payroll_inputs ADD COLUMN leave_type_id uuid;
ALTER TABLE public.hrm_payroll_inputs ADD COLUMN resolved_entitlement_plan_id uuid;
ALTER TABLE public.hrm_payroll_inputs ADD COLUMN resolved_entitlement_mapping_id uuid;
ALTER TABLE public.hrm_payroll_inputs ADD COLUMN resolved_entitlement_plan_updated_at timestamptz;
UPDATE public.hrm_payroll_inputs i
   SET leave_type_id = r.leave_type_id
  FROM public.hrm_leave_requests r
 WHERE r.org_id = i.org_id AND r.id = i.source_leave_request_id
   AND i.leave_type_id IS NULL;
ALTER TABLE public.hrm_payroll_inputs ALTER COLUMN leave_type_id SET NOT NULL;
ALTER TABLE public.hrm_payroll_inputs
  ADD CONSTRAINT hrm_payroll_inputs_leave_type_tenant_fkey
  FOREIGN KEY (org_id, leave_type_id) REFERENCES public.hrm_leave_types (org_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.hrm_payroll_inputs
  ADD CONSTRAINT hrm_payroll_inputs_resolved_plan_tenant_fkey
  FOREIGN KEY (org_id, resolved_entitlement_plan_id) REFERENCES public.entitlement_plans (org_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.hrm_leave_payroll_entitlement_mappings (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  leave_type_id uuid NOT NULL,
  entitlement_plan_id uuid NOT NULL,
  effective_from date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES public.users(id),
  CONSTRAINT hrm_leave_payroll_entitlement_mappings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT hrm_leave_payroll_entitlement_mappings_effective_unique UNIQUE (org_id, leave_type_id, effective_from),
  CONSTRAINT hrm_leave_payroll_entitlement_mappings_leave_type_fkey
    FOREIGN KEY (org_id, leave_type_id) REFERENCES public.hrm_leave_types (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT hrm_leave_payroll_entitlement_mappings_plan_fkey
    FOREIGN KEY (org_id, entitlement_plan_id) REFERENCES public.entitlement_plans (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT hrm_leave_payroll_entitlement_mappings_effective_date
    CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
);
ALTER TABLE public.hrm_payroll_inputs
  ADD CONSTRAINT hrm_payroll_inputs_resolved_mapping_tenant_fkey
  FOREIGN KEY (org_id, resolved_entitlement_mapping_id)
  REFERENCES public.hrm_leave_payroll_entitlement_mappings (org_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX hrm_leave_payroll_entitlement_mappings_lookup
  ON public.hrm_leave_payroll_entitlement_mappings (org_id, leave_type_id, effective_from DESC);

ALTER TABLE public.hrm_leave_payroll_entitlement_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_leave_payroll_entitlement_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_leave_payroll_entitlement_mappings
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.hrm_leave_payroll_entitlement_mappings IS 'openbooks:org_isolation:v1';
CREATE TRIGGER hrm_leave_payroll_entitlement_mappings_immutable
  BEFORE UPDATE OR DELETE ON public.hrm_leave_payroll_entitlement_mappings
  FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();
CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_leave_payroll_entitlement_mappings
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

COMMENT ON TABLE public.hrm_leave_payroll_entitlement_mappings IS
  'Effective-dated destination for approved banked leave payroll inputs. Each active mapping targets a non-vacation hours entitlement plan; a newer inactive version explicitly ends the mapping.';
COMMENT ON COLUMN public.hrm_payroll_inputs.leave_type_id IS
  'Leave type captured when the approved absence became a payroll input; it selects the effective banked-leave entitlement mapping.';
COMMENT ON COLUMN public.hrm_payroll_inputs.resolved_entitlement_mapping_id IS
  'Effective leave-to-entitlement policy version selected when payroll consumed this banked absence.';
COMMENT ON COLUMN public.hrm_payroll_inputs.resolved_entitlement_plan_updated_at IS
  'Plan version timestamp used by payroll to refuse committing banked leave against a changed plan.';
