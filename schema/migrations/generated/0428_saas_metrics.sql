-- OpenBooks forward migration 0428_saas_metrics.
-- Store reproducible, subsidiary-scoped SaaS metrics facts and admit their scheduled recompute scan.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.saas_metrics_monthly (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  month date NOT NULL,
  cohort_month date NOT NULL,
  mrr_start numeric(19,4) NOT NULL,
  mrr_end numeric(19,4) NOT NULL,
  new_mrr numeric(19,4) NOT NULL,
  expansion_mrr numeric(19,4) NOT NULL,
  contraction_mrr numeric(19,4) NOT NULL,
  churned_mrr numeric(19,4) NOT NULL,
  reactivation_mrr numeric(19,4) NOT NULL,
  movement text NOT NULL,
  recognized_revenue numeric(19,4) NOT NULL,
  deferred_delta numeric(19,4) NOT NULL,
  inputs_hash text NOT NULL,
  computed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT saas_metrics_monthly_pkey PRIMARY KEY (id),
  CONSTRAINT saas_metrics_monthly_org_fk FOREIGN KEY (org_id)
    REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_monthly_subsidiary_fk FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_monthly_customer_fk FOREIGN KEY (org_id, customer_id)
    REFERENCES public.parties(org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_monthly_subscription_fk FOREIGN KEY (org_id, subscription_id)
    REFERENCES public.subscriptions(org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_monthly_movement_valid CHECK (movement IN ('new', 'expansion', 'contraction', 'churn', 'reactivation', 'flat')),
  CONSTRAINT saas_metrics_monthly_nonnegative_mrr CHECK (
    mrr_start >= 0 AND mrr_end >= 0 AND new_mrr >= 0 AND expansion_mrr >= 0
    AND contraction_mrr >= 0 AND churned_mrr >= 0 AND reactivation_mrr >= 0
  ),
  CONSTRAINT saas_metrics_monthly_movement_identity CHECK (
    mrr_end - mrr_start = new_mrr + expansion_mrr + reactivation_mrr - contraction_mrr - churned_mrr
  ),
  CONSTRAINT saas_metrics_monthly_month_start CHECK (extract(day FROM month) = 1 AND extract(day FROM cohort_month) = 1)
);

CREATE UNIQUE INDEX saas_metrics_monthly_org_month_subscription
  ON public.saas_metrics_monthly (org_id, month, subscription_id);
CREATE UNIQUE INDEX saas_metrics_monthly_org_id_id_unique
  ON public.saas_metrics_monthly (org_id, id);
CREATE INDEX saas_metrics_monthly_org_sub_month
  ON public.saas_metrics_monthly (org_id, subsidiary_id, month);
ALTER TABLE public.saas_metrics_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_metrics_monthly FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.saas_metrics_monthly
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.saas_metrics_facts_monthly (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  month date NOT NULL,
  mrr_start numeric(19,4) NOT NULL,
  mrr_end numeric(19,4) NOT NULL,
  new_mrr numeric(19,4) NOT NULL,
  expansion_mrr numeric(19,4) NOT NULL,
  contraction_mrr numeric(19,4) NOT NULL,
  churned_mrr numeric(19,4) NOT NULL,
  reactivation_mrr numeric(19,4) NOT NULL,
  recognized_revenue numeric(19,4) NOT NULL,
  deferred_delta numeric(19,4) NOT NULL,
  mrr_at_risk numeric(19,4) NOT NULL,
  customers_start integer NOT NULL,
  customers_end integer NOT NULL,
  customers_new integer NOT NULL,
  customers_churned integer NOT NULL,
  customers_reactivated integer NOT NULL,
  gl_revenue numeric(19,4) NOT NULL,
  gl_cogs numeric(19,4) NOT NULL,
  bookings numeric(19,4) NOT NULL,
  billings numeric(19,4) NOT NULL,
  deferred_balance numeric(19,4) NOT NULL,
  basis text NOT NULL,
  inputs_hash text NOT NULL,
  computed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT saas_metrics_facts_monthly_pkey PRIMARY KEY (id),
  CONSTRAINT saas_metrics_facts_monthly_org_fk FOREIGN KEY (org_id)
    REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_facts_monthly_subsidiary_fk FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_facts_monthly_basis_valid CHECK (basis IN ('recognised', 'billed')),
  CONSTRAINT saas_metrics_facts_monthly_counts_nonnegative CHECK (
    customers_start >= 0 AND customers_end >= 0 AND customers_new >= 0
    AND customers_churned >= 0 AND customers_reactivated >= 0
  ),
  CONSTRAINT saas_metrics_facts_monthly_month_start CHECK (extract(day FROM month) = 1)
);

CREATE UNIQUE INDEX saas_metrics_facts_monthly_org_sub_month
  ON public.saas_metrics_facts_monthly (org_id, subsidiary_id, month);
CREATE UNIQUE INDEX saas_metrics_facts_monthly_org_id_id_unique
  ON public.saas_metrics_facts_monthly (org_id, id);
ALTER TABLE public.saas_metrics_facts_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_metrics_facts_monthly FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.saas_metrics_facts_monthly
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.saas_metrics_cohort_monthly (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  cohort_month date NOT NULL,
  month date NOT NULL,
  months_since_start integer NOT NULL,
  start_mrr numeric(19,4) NOT NULL,
  mrr numeric(19,4) NOT NULL,
  start_customers integer NOT NULL,
  customers integer NOT NULL,
  inputs_hash text NOT NULL,
  computed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT saas_metrics_cohort_monthly_pkey PRIMARY KEY (id),
  CONSTRAINT saas_metrics_cohort_monthly_org_fk FOREIGN KEY (org_id)
    REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_cohort_monthly_subsidiary_fk FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_cohort_monthly_months_nonnegative CHECK (months_since_start >= 0),
  CONSTRAINT saas_metrics_cohort_monthly_counts_nonnegative CHECK (start_customers >= 0 AND customers >= 0),
  CONSTRAINT saas_metrics_cohort_monthly_mrr_nonnegative CHECK (start_mrr >= 0 AND mrr >= 0),
  CONSTRAINT saas_metrics_cohort_monthly_month_start CHECK (
    extract(day FROM cohort_month) = 1 AND extract(day FROM month) = 1 AND month >= cohort_month
  )
);

CREATE UNIQUE INDEX saas_metrics_cohort_monthly_org_sub_cohort_month
  ON public.saas_metrics_cohort_monthly (org_id, subsidiary_id, cohort_month, month);
CREATE UNIQUE INDEX saas_metrics_cohort_monthly_org_id_id_unique
  ON public.saas_metrics_cohort_monthly (org_id, id);
CREATE INDEX saas_metrics_cohort_monthly_org_month
  ON public.saas_metrics_cohort_monthly (org_id, month);
ALTER TABLE public.saas_metrics_cohort_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_metrics_cohort_monthly FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.saas_metrics_cohort_monthly
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.saas_metrics_monthly IS
  'Monthly subscription revenue facts. mrr_start and mrr_end are stocks; movement amounts, recognized_revenue, and deferred_delta are flows.';
COMMENT ON TABLE public.saas_metrics_facts_monthly IS
  'Monthly SaaS facts by legal entity. mrr_start, mrr_end, customers_start, customers_end, and deferred_balance are stocks; other amounts and counts are flows.';
COMMENT ON TABLE public.saas_metrics_cohort_monthly IS
  'Monthly cohort facts by legal entity. start_mrr, mrr, start_customers, and customers are cohort-level stocks; do not sum across months.';

-- The catalog's unique relation key makes this registration safely replayable.
INSERT INTO openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('saas_metrics_monthly', '0428_saas_metrics'),
  ('saas_metrics_facts_monthly', '0428_saas_metrics'),
  ('saas_metrics_cohort_monthly', '0428_saas_metrics')
ON CONFLICT (relation) DO NOTHING;
SELECT openbooks_refresh_query_catalog();

ALTER TABLE public.scheduler_outbox DROP CONSTRAINT IF EXISTS scheduler_outbox_kind;
ALTER TABLE public.scheduler_outbox ADD CONSTRAINT scheduler_outbox_kind CHECK (
  kind = ANY (ARRAY[
    'dunning'::text,
    'subscription_billing'::text,
    'property_billing'::text,
    'fx_providers'::text,
    'approval_escalation'::text,
    'flow_email'::text,
    'allocation_run'::text,
    'saas_metrics'::text
  ])
);

ALTER TABLE public.scheduler_outbox DROP CONSTRAINT IF EXISTS scheduler_outbox_scope;
ALTER TABLE public.scheduler_outbox ADD CONSTRAINT scheduler_outbox_scope CHECK (
  ((kind = 'approval_escalation') AND org_id IS NOT NULL AND subject_id IS NOT NULL)
  OR ((kind = ANY (ARRAY['dunning'::text, 'subscription_billing'::text, 'property_billing'::text, 'fx_providers'::text, 'saas_metrics'::text])) AND org_id IS NULL AND subject_id IS NULL)
  OR ((kind = 'flow_email') AND org_id IS NOT NULL AND subject_id IS NOT NULL AND payload IS NOT NULL)
  OR ((kind = 'allocation_run') AND org_id IS NOT NULL AND subject_id IS NOT NULL AND payload IS NOT NULL)
);
