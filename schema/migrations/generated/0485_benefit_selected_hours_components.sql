-- Per-hour benefit contributions counted over an explicit component list.
-- A group retirement arrangement prices each contribution from the signed
-- hours on named earning components (regular, overtime, statutory holiday and
-- banked-time-taken hours count; quantity-based units never do), so the rule
-- names its hours basis 'selected_components' and lists the counted
-- components in hrm_benefit_contribution_rule_components. Only earning
-- components may be listed: the pay run counts stub earning-line hours, and a
-- deduction or contribution row would silently match nothing.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_benefit_contribution_rules
 DROP CONSTRAINT hrm_benefit_contribution_rules_hours_basis_check;
ALTER TABLE public.hrm_benefit_contribution_rules
 ADD CONSTRAINT hrm_benefit_contribution_rules_hours_basis_check
 CHECK (hours_basis = ANY (ARRAY['all_paid'::text, 'regular_paid'::text, 'scheduled_paid'::text, 'selected_components'::text]));

CREATE TABLE public.hrm_benefit_contribution_rule_components (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL, plan_id uuid NOT NULL, rule_id uuid NOT NULL,
 pay_component_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id,id), UNIQUE (org_id,rule_id,pay_component_id),
 FOREIGN KEY (org_id,plan_id) REFERENCES public.hrm_benefit_plans(org_id,id),
 FOREIGN KEY (org_id,plan_id,rule_id) REFERENCES public.hrm_benefit_contribution_rules(org_id,plan_id,id),
 FOREIGN KEY (org_id,pay_component_id) REFERENCES public.pay_components(org_id,id)
);
ALTER TABLE public.hrm_benefit_contribution_rule_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_benefit_contribution_rule_components FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_benefit_contribution_rule_components
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.hrm_benefit_contribution_rule_components IS 'openbooks:org_isolation:v1';
