-- OpenBooks forward migration 0689_fixed_asset_maintenance_and_insurance.
--
-- Maintenance and insurance registers for fixed assets. Neither posts to
-- the ledger: maintenance records link to the vendor bills that paid for the
-- work, and a capitalized betterment travels through the asset proposal
-- queue rather than being booked here.
--
-- asset_usage_readings records meter readings (hours, kilometres, cycles)
-- per asset. asset_maintenance_schedules hold time and/or usage intervals
-- with the computed next due date and meter value;
-- asset_maintenance_records record work performed, its vendor, cost,
-- expense-or-betterment treatment and the paying bill line.
-- asset_maintenance_alerts make due and overdue notifications idempotent per
-- schedule and due point.
--
-- asset_insurance_policies hold insurer, policy number, coverage period,
-- premium and deductible; asset_insurance_coverages list each covered asset
-- with its insured and replacement value; asset_insurance_alerts make
-- renewal notifications idempotent per policy and lead time.
--
-- Roles, overrides and API key scopes holding assets.manage also receive
-- assets.maintain, which maintaining these registers requires.
--
-- Backfill: none. New tables arrive empty.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.asset_usage_readings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    read_on date NOT NULL,
    reading numeric(19,4) NOT NULL,
    unit text NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT asset_usage_readings_pkey PRIMARY KEY (id),
    CONSTRAINT asset_usage_readings_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_usage_readings_reading CHECK (reading >= 0),
    CONSTRAINT asset_usage_readings_unit CHECK (length(btrim(unit)) BETWEEN 1 AND 40),
    CONSTRAINT asset_usage_readings_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_usage_readings_asset_fkey FOREIGN KEY (org_id, asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_usage_readings_created_by_fkey FOREIGN KEY (org_id, created_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE INDEX asset_usage_readings_asset ON public.asset_usage_readings (org_id, asset_id, unit, read_on DESC);

CREATE TABLE public.asset_maintenance_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    interval_months integer,
    interval_usage numeric(19,4),
    usage_unit text,
    starts_on date NOT NULL,
    last_performed_on date,
    last_performed_usage numeric(19,4),
    next_due_on date,
    next_due_usage numeric(19,4),
    vendor_party_id uuid,
    estimated_cost numeric(19,4),
    lead_days integer DEFAULT 14 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT asset_maintenance_schedules_pkey PRIMARY KEY (id),
    CONSTRAINT asset_maintenance_schedules_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_maintenance_schedules_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT asset_maintenance_schedules_interval CHECK (interval_months IS NOT NULL OR interval_usage IS NOT NULL),
    CONSTRAINT asset_maintenance_schedules_interval_months CHECK (interval_months IS NULL OR interval_months BETWEEN 1 AND 600),
    CONSTRAINT asset_maintenance_schedules_interval_usage CHECK (interval_usage IS NULL OR interval_usage > 0),
    CONSTRAINT asset_maintenance_schedules_usage_unit CHECK ((interval_usage IS NULL) = (usage_unit IS NULL)),
    CONSTRAINT asset_maintenance_schedules_estimated_cost CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
    CONSTRAINT asset_maintenance_schedules_lead_days CHECK (lead_days BETWEEN 0 AND 365),
    CONSTRAINT asset_maintenance_schedules_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_maintenance_schedules_asset_fkey FOREIGN KEY (org_id, asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_schedules_vendor_party_fkey FOREIGN KEY (org_id, vendor_party_id)
      REFERENCES public.parties(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_schedules_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
    CONSTRAINT asset_maintenance_schedules_updated_by_fkey FOREIGN KEY (updated_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE
);

CREATE INDEX asset_maintenance_schedules_asset ON public.asset_maintenance_schedules (org_id, asset_id);
CREATE INDEX asset_maintenance_schedules_due ON public.asset_maintenance_schedules (org_id, next_due_on) WHERE is_active;

CREATE TABLE public.asset_maintenance_records (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    schedule_id uuid,
    performed_on date NOT NULL,
    usage_reading numeric(19,4),
    description text NOT NULL,
    vendor_party_id uuid,
    cost numeric(19,4) DEFAULT 0 NOT NULL,
    treatment text NOT NULL,
    source_document_id uuid,
    source_document_line_id uuid,
    proposal_id uuid,
    status text DEFAULT 'recorded' NOT NULL,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT asset_maintenance_records_pkey PRIMARY KEY (id),
    CONSTRAINT asset_maintenance_records_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_maintenance_records_description CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
    CONSTRAINT asset_maintenance_records_cost CHECK (cost >= 0),
    CONSTRAINT asset_maintenance_records_usage CHECK (usage_reading IS NULL OR usage_reading >= 0),
    CONSTRAINT asset_maintenance_records_treatment CHECK (treatment IN ('expense', 'betterment')),
    CONSTRAINT asset_maintenance_records_betterment_source CHECK (treatment = 'expense' OR proposal_id IS NOT NULL),
    CONSTRAINT asset_maintenance_records_line_needs_document CHECK (source_document_line_id IS NULL OR source_document_id IS NOT NULL),
    CONSTRAINT asset_maintenance_records_status CHECK (status IN ('recorded', 'cancelled')),
    CONSTRAINT asset_maintenance_records_cancel_shape CHECK (
      (status = 'recorded' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL)
      OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
          AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) > 0)),
    CONSTRAINT asset_maintenance_records_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_maintenance_records_asset_fkey FOREIGN KEY (org_id, asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_records_schedule_fkey FOREIGN KEY (org_id, schedule_id)
      REFERENCES public.asset_maintenance_schedules(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_records_vendor_party_fkey FOREIGN KEY (org_id, vendor_party_id)
      REFERENCES public.parties(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_records_source_document_fkey FOREIGN KEY (org_id, source_document_id)
      REFERENCES public.documents(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_records_source_document_line_fkey FOREIGN KEY (org_id, source_document_line_id)
      REFERENCES public.document_lines(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_records_proposal_fkey FOREIGN KEY (org_id, proposal_id)
      REFERENCES public.asset_proposals(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_records_created_by_fkey FOREIGN KEY (org_id, created_by)
      REFERENCES public.users(org_id, id) DEFERRABLE,
    CONSTRAINT asset_maintenance_records_cancelled_by_fkey FOREIGN KEY (org_id, cancelled_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE INDEX asset_maintenance_records_asset ON public.asset_maintenance_records (org_id, asset_id, performed_on DESC);
CREATE INDEX asset_maintenance_records_schedule ON public.asset_maintenance_records (org_id, schedule_id) WHERE schedule_id IS NOT NULL;

CREATE TABLE public.asset_maintenance_alerts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    due_key text NOT NULL,
    stage text NOT NULL,
    notified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_maintenance_alerts_pkey PRIMARY KEY (id),
    CONSTRAINT asset_maintenance_alerts_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_maintenance_alerts_once UNIQUE (org_id, schedule_id, due_key, stage),
    CONSTRAINT asset_maintenance_alerts_stage CHECK (stage IN ('due', 'overdue')),
    CONSTRAINT asset_maintenance_alerts_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_maintenance_alerts_schedule_fkey FOREIGN KEY (org_id, schedule_id)
      REFERENCES public.asset_maintenance_schedules(org_id, id) ON DELETE CASCADE DEFERRABLE
);

CREATE TABLE public.asset_insurance_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    insurer_party_id uuid NOT NULL,
    policy_number text NOT NULL,
    description text,
    coverage_starts_on date NOT NULL,
    coverage_ends_on date NOT NULL,
    premium numeric(19,4) DEFAULT 0 NOT NULL,
    deductible numeric(19,4) DEFAULT 0 NOT NULL,
    currency text NOT NULL,
    renewal_lead_days integer DEFAULT 30 NOT NULL,
    status text DEFAULT 'active' NOT NULL,
    renews_policy_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT asset_insurance_policies_pkey PRIMARY KEY (id),
    CONSTRAINT asset_insurance_policies_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_insurance_policies_identity UNIQUE (org_id, insurer_party_id, policy_number, coverage_starts_on),
    CONSTRAINT asset_insurance_policies_number CHECK (length(btrim(policy_number)) BETWEEN 1 AND 120),
    CONSTRAINT asset_insurance_policies_period CHECK (coverage_ends_on >= coverage_starts_on),
    CONSTRAINT asset_insurance_policies_amounts CHECK (premium >= 0 AND deductible >= 0),
    CONSTRAINT asset_insurance_policies_lead_days CHECK (renewal_lead_days BETWEEN 0 AND 365),
    CONSTRAINT asset_insurance_policies_status CHECK (status IN ('active', 'cancelled')),
    CONSTRAINT asset_insurance_policies_not_self_renewal CHECK (renews_policy_id IS NULL OR renews_policy_id <> id),
    CONSTRAINT asset_insurance_policies_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_insurance_policies_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
      REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_insurance_policies_insurer_party_fkey FOREIGN KEY (org_id, insurer_party_id)
      REFERENCES public.parties(org_id, id) DEFERRABLE,
    CONSTRAINT asset_insurance_policies_renews_fkey FOREIGN KEY (org_id, renews_policy_id)
      REFERENCES public.asset_insurance_policies(org_id, id) DEFERRABLE,
    CONSTRAINT asset_insurance_policies_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
    CONSTRAINT asset_insurance_policies_updated_by_fkey FOREIGN KEY (updated_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE
);

CREATE INDEX asset_insurance_policies_renewal ON public.asset_insurance_policies (org_id, coverage_ends_on) WHERE status = 'active';

CREATE TABLE public.asset_insurance_coverages (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    insured_value numeric(19,4) NOT NULL,
    replacement_value numeric(19,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT asset_insurance_coverages_pkey PRIMARY KEY (id),
    CONSTRAINT asset_insurance_coverages_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_insurance_coverages_once UNIQUE (org_id, policy_id, asset_id),
    CONSTRAINT asset_insurance_coverages_values CHECK (insured_value >= 0 AND (replacement_value IS NULL OR replacement_value >= 0)),
    CONSTRAINT asset_insurance_coverages_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_insurance_coverages_policy_fkey FOREIGN KEY (org_id, policy_id)
      REFERENCES public.asset_insurance_policies(org_id, id) DEFERRABLE,
    CONSTRAINT asset_insurance_coverages_asset_fkey FOREIGN KEY (org_id, asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_insurance_coverages_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
    CONSTRAINT asset_insurance_coverages_updated_by_fkey FOREIGN KEY (updated_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE
);

CREATE INDEX asset_insurance_coverages_asset ON public.asset_insurance_coverages (org_id, asset_id);

CREATE TABLE public.asset_insurance_alerts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    lead_days integer NOT NULL,
    notified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_insurance_alerts_pkey PRIMARY KEY (id),
    CONSTRAINT asset_insurance_alerts_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_insurance_alerts_once UNIQUE (org_id, policy_id, lead_days),
    CONSTRAINT asset_insurance_alerts_lead_days CHECK (lead_days >= 0),
    CONSTRAINT asset_insurance_alerts_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_insurance_alerts_policy_fkey FOREIGN KEY (org_id, policy_id)
      REFERENCES public.asset_insurance_policies(org_id, id) ON DELETE CASCADE DEFERRABLE
);

DO $tables$
DECLARE
  rel text;
BEGIN
 FOREACH rel IN ARRAY ARRAY['asset_usage_readings', 'asset_maintenance_schedules', 'asset_maintenance_records',
   'asset_maintenance_alerts', 'asset_insurance_policies', 'asset_insurance_coverages', 'asset_insurance_alerts'] LOOP
  EXECUTE format('ALTER TABLE ONLY public.%I ENABLE ROW LEVEL SECURITY', rel);
  EXECUTE format('ALTER TABLE ONLY public.%I FORCE ROW LEVEL SECURITY', rel);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING (public.app_bypass_rls_active() OR org_id::text = current_setting(''app.current_org'', true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting(''app.current_org'', true))', rel);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS %L', rel, 'openbooks:org_isolation:v1');
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = rel AND t.tgname = 'tenant_retirement_fence') THEN
   EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', rel);
  END IF;
 END LOOP;
END $tables$;

UPDATE app_roles SET permissions = permissions || '["assets.maintain"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'assets.manage' OR permissions ? 'assets.*')
   AND NOT (permissions ? 'assets.maintain' OR permissions ? '*');

INSERT INTO user_permission_overrides (org_id, user_id, permission, effect)
SELECT DISTINCT o.org_id, o.user_id, m.new_key, o.effect
  FROM user_permission_overrides o
  JOIN (VALUES ('assets.manage', 'assets.maintain'),
               ('assets.*', 'assets.maintain')) AS m(old_key, new_key)
    ON m.old_key = o.permission
-- An explicit override a user already holds for the new key keeps deciding it.
ON CONFLICT (user_id, permission) DO NOTHING;

UPDATE api_keys SET scopes = scopes || '["assets.maintain"]'::jsonb
 WHERE (scopes ? 'assets.manage' OR scopes ? 'assets.*')
   AND NOT (scopes ? 'assets.maintain' OR scopes ? '*');

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('asset_usage_readings', '0689_fixed_asset_maintenance_and_insurance'),
  ('asset_maintenance_schedules', '0689_fixed_asset_maintenance_and_insurance'),
  ('asset_maintenance_records', '0689_fixed_asset_maintenance_and_insurance'),
  ('asset_maintenance_alerts', '0689_fixed_asset_maintenance_and_insurance'),
  ('asset_insurance_policies', '0689_fixed_asset_maintenance_and_insurance'),
  ('asset_insurance_coverages', '0689_fixed_asset_maintenance_and_insurance'),
  ('asset_insurance_alerts', '0689_fixed_asset_maintenance_and_insurance')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
