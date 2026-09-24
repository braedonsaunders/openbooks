-- OpenBooks forward migration 0355_payroll_employer_facts.
-- Store pack-declared employer facts as effective-dated, tenant-scoped evidence.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.payroll_employer_facts (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  country text NOT NULL,
  fact_key text NOT NULL,
  effective_from date NOT NULL,
  value_kind text NOT NULL,
  fact_value text NOT NULL,
  value_scale integer,
  superseded_on date,
  change_reason text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT payroll_employer_facts_value_kind
    CHECK (value_kind = ANY (ARRAY['choice'::text, 'integer'::text, 'decimal'::text, 'boolean'::text])),
  CONSTRAINT payroll_employer_facts_decimal_scale
    CHECK (((value_kind = 'decimal'::text) AND (value_scale BETWEEN 0 AND 10))
        OR ((value_kind <> 'decimal'::text) AND (value_scale IS NULL))),
  CONSTRAINT payroll_employer_facts_reason CHECK (length(btrim(change_reason)) > 0),
  CONSTRAINT payroll_employer_facts_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_employer_facts_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT payroll_employer_facts_org_subsidiary_fkey
    FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT payroll_employer_facts_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT payroll_employer_facts_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

ALTER TABLE public.payroll_employer_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_employer_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.payroll_employer_facts
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true));

CREATE UNIQUE INDEX payroll_employer_facts_org_point
  ON public.payroll_employer_facts
    (org_id, subsidiary_id, country, fact_key, effective_from)
  WHERE superseded_on IS NULL;
CREATE INDEX payroll_employer_facts_org_effective
  ON public.payroll_employer_facts (org_id, country, fact_key, effective_from);

COMMENT ON TABLE public.payroll_employer_facts IS
  'Effective-dated employer facts declared by payroll country packs. Values are entered through Payroll Setup, preserve actor/reason audit, and are superseded rather than deleted.';
COMMENT ON COLUMN public.payroll_employer_facts.subsidiary_id IS
  'Legal-employer scope: the organization-owned legal subsidiary that employs the payroll population.';
COMMENT ON COLUMN public.payroll_employer_facts.value_scale IS
  'Exact decimal scale for decimal facts; null for choices, integers, and booleans.';

SELECT public.openbooks_refresh_query_catalog();
