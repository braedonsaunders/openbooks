-- Active benefit programs change through dated revisions. Each revision keeps
-- the complete policy it replaces (program row, measure scopes, source
-- accounts and transaction rules) and the date the change applies from;
-- periods that start before that date measure under the prior policy.
-- Revisions are append-only. An active program row or its transaction rules
-- change only in the transaction that records the revision; identity
-- (code, family, employer, currency, start date, measure and delivery)
-- never changes once active.
CREATE TABLE IF NOT EXISTS public.hrm_benefit_program_revisions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 program_id uuid NOT NULL,
 effective_from date NOT NULL,
 prior_policy jsonb NOT NULL CHECK (jsonb_typeof(prior_policy) = 'object'),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 created_txid bigint NOT NULL DEFAULT txid_current(),
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, program_id) REFERENCES public.hrm_benefit_programs(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
CREATE INDEX IF NOT EXISTS hrm_benefit_program_revisions_program
 ON public.hrm_benefit_program_revisions (org_id, program_id, effective_from);
COMMENT ON TABLE public.hrm_benefit_program_revisions IS 'Append-only dated revisions of active benefit programs; prior_policy governs periods starting before effective_from.';

CREATE OR REPLACE FUNCTION public.hrm_benefit_program_revision_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Benefit program revisions are append-only history; record a later revision instead.';
END;
$$;
DROP TRIGGER IF EXISTS hrm_benefit_program_revision_immutable ON public.hrm_benefit_program_revisions;
CREATE TRIGGER hrm_benefit_program_revision_immutable BEFORE UPDATE OR DELETE ON public.hrm_benefit_program_revisions
 FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_program_revision_immutable();

ALTER TABLE public.hrm_benefit_program_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_benefit_program_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.hrm_benefit_program_revisions;
CREATE POLICY org_isolation ON public.hrm_benefit_program_revisions
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.hrm_benefit_program_revisions IS 'openbooks:org_isolation:v1';

-- True only inside the transaction that recorded a revision of the program.
CREATE OR REPLACE FUNCTION public.hrm_benefit_program_revision_open(p_org uuid, p_program uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.hrm_benefit_program_revisions
     WHERE org_id = p_org AND program_id = p_program AND created_txid = txid_current()
  )
$$;

CREATE OR REPLACE FUNCTION public.hrm_benefit_program_active_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'active'
     AND public.hrm_benefit_program_revision_open(OLD.org_id, OLD.id) THEN
    IF NEW.code IS DISTINCT FROM OLD.code
      OR NEW.family IS DISTINCT FROM OLD.family
      OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.metric IS DISTINCT FROM OLD.metric
      OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method THEN
      RAISE EXCEPTION
        'HRM benefit program % keeps its code, family, employer, currency, start date, measure and delivery while active — close it and create a new program to change them.', OLD.id;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('active', 'closed') AND (
    NEW.code IS DISTINCT FROM OLD.code
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.family IS DISTINCT FROM OLD.family
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
    OR NEW.pay_component_id IS DISTINCT FROM OLD.pay_component_id
    OR NEW.approval_mode IS DISTINCT FROM OLD.approval_mode
    OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
    OR NEW.valuation IS DISTINCT FROM OLD.valuation
    OR NEW.metric IS DISTINCT FROM OLD.metric
    OR NEW.metric_scope IS DISTINCT FROM OLD.metric_scope
    OR NEW.allocation IS DISTINCT FROM OLD.allocation
    OR NEW.percent_rate IS DISTINCT FROM OLD.percent_rate
    OR NEW.fixed_amount IS DISTINCT FROM OLD.fixed_amount
    OR NEW.cap_amount IS DISTINCT FROM OLD.cap_amount
    OR NEW.budget_amount IS DISTINCT FROM OLD.budget_amount
    OR NEW.threshold_amount IS DISTINCT FROM OLD.threshold_amount
    OR NEW.frequency IS DISTINCT FROM OLD.frequency
    OR NEW.period_basis IS DISTINCT FROM OLD.period_basis
    OR NEW.payment_delay_days IS DISTINCT FROM OLD.payment_delay_days
    OR (NEW.status NOT IN ('active', 'closed'))
  ) THEN
    RAISE EXCEPTION
      'HRM benefit program % is % policy — edit it with a change date to revise its rules; closed programs keep their history.', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$func$;

-- Transaction rules of an active program change alongside a revision. The
-- installed guard body is patched in place so every other clause it carries
-- (including retirement DELETE authority) is preserved exactly.
DO $patch$
DECLARE proc record; source text; patched text;
BEGIN
  SELECT p.oid, p.prosrc INTO proc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'benefit_transaction_rule_guard' AND p.pronargs = 0;
  IF NOT FOUND THEN RAISE EXCEPTION 'benefit_transaction_rule_guard is not installed'; END IF;
  source := proc.prosrc;
  IF position('hrm_benefit_program_revision_open' IN source) > 0 THEN
    RETURN; -- expected on replay: already admits revisions
  END IF;
  IF (length(source) - length(replace(source, 'IF program_status<>''draft'' THEN', ''))) / length('IF program_status<>''draft'' THEN') <> 1 THEN
    RAISE EXCEPTION 'benefit_transaction_rule_guard differs from the published definition; reconcile it before applying this migration';
  END IF;
  patched := replace(source, 'IF program_status<>''draft'' THEN',
    'IF program_status<>''draft'' AND NOT (program_status=''active'' AND public.hrm_benefit_program_revision_open(owner_org,owner_program)) THEN');
  patched := replace(patched,
    'Active benefit transaction rules are immutable; close the program and create a replacement with new effective dates.',
    'Active benefit transaction rules change through a dated program revision; save them with a change date.');
  EXECUTE replace(pg_get_functiondef(proc.oid), source, patched);
END;
$patch$;

INSERT INTO public.openbooks_query_catalog_relations(relation, added_in)
 VALUES ('hrm_benefit_program_revisions', '0667_benefit_program_revisions')
 ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
