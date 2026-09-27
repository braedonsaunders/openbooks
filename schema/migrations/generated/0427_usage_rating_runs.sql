-- OpenBooks forward migration 0427_usage_rating_runs.
-- Retain immutable rating inputs and outputs beside each usage invoice.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.usage_rating_runs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  link_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  input_hash text NOT NULL,
  output_hash text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  supersedes_run_id uuid,
  invoice_id uuid,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT usage_rating_runs_pkey PRIMARY KEY (id),
  CONSTRAINT usage_rating_runs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_rating_runs_period_valid CHECK (period_start <= period_end),
  CONSTRAINT usage_rating_runs_hashes_valid CHECK
    (input_hash ~ '^[0-9a-f]{64}$' AND output_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT usage_rating_runs_status_valid CHECK (status IN ('active', 'superseded')),
  CONSTRAINT usage_rating_runs_not_self_superseding CHECK
    (supersedes_run_id IS NULL OR supersedes_run_id <> id),
  CONSTRAINT usage_rating_runs_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_rating_runs_link_org_fk
    FOREIGN KEY (org_id, link_id) REFERENCES public.subscription_usage_links(org_id, id) DEFERRABLE,
  CONSTRAINT usage_rating_runs_version_org_fk
    FOREIGN KEY (org_id, plan_version_id) REFERENCES public.usage_rating_plan_versions(org_id, id) DEFERRABLE,
  CONSTRAINT usage_rating_runs_supersedes_org_fk
    FOREIGN KEY (org_id, supersedes_run_id) REFERENCES public.usage_rating_runs(org_id, id) DEFERRABLE,
  CONSTRAINT usage_rating_runs_invoice_org_fk
    FOREIGN KEY (org_id, invoice_id) REFERENCES public.documents(org_id, id) DEFERRABLE
);

CREATE UNIQUE INDEX usage_rating_runs_active_window_unique
  ON public.usage_rating_runs (org_id, link_id, period_start, period_end)
  WHERE status = 'active';
CREATE INDEX usage_rating_runs_invoice ON public.usage_rating_runs (org_id, invoice_id);

ALTER TABLE public.usage_rating_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_rating_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_rating_runs
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

ALTER TABLE public.usage_prepaid_draws
  ADD CONSTRAINT usage_prepaid_draws_run_org_fk
  FOREIGN KEY (org_id, run_id) REFERENCES public.usage_rating_runs(org_id, id) DEFERRABLE;

ALTER TABLE public.usage_prepaid_draws
  ADD COLUMN reverses_draw_id uuid;
ALTER TABLE public.usage_prepaid_draws
  ADD CONSTRAINT usage_prepaid_draws_reverses_org_fk
  FOREIGN KEY (org_id, reverses_draw_id)
  REFERENCES public.usage_prepaid_draws(org_id, id) DEFERRABLE;
ALTER TABLE public.usage_prepaid_draws
  DROP CONSTRAINT usage_prepaid_draws_amount_positive;
ALTER TABLE public.usage_prepaid_draws
  ADD CONSTRAINT usage_prepaid_draws_amount_positive
  CHECK ((reverses_draw_id IS NULL AND amount > 0)
      OR (reverses_draw_id IS NOT NULL AND amount < 0));
DROP INDEX public.usage_prepaid_draws_run_grant_period_unique;
CREATE UNIQUE INDEX usage_prepaid_draws_run_grant_period_unique
  ON public.usage_prepaid_draws (org_id, run_id, grant_id, period_month)
  WHERE reverses_draw_id IS NULL;
CREATE UNIQUE INDEX usage_prepaid_draws_reverses_draw_unique
  ON public.usage_prepaid_draws (org_id, reverses_draw_id)
  WHERE reverses_draw_id IS NOT NULL;

CREATE FUNCTION public.usage_rating_runs_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a rating run must begin active';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.link_id IS DISTINCT FROM OLD.link_id
     OR NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
     OR NEW.output_hash IS DISTINCT FROM OLD.output_hash
     OR NEW.supersedes_run_id IS DISTINCT FROM OLD.supersedes_run_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
         AND NOT (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NULL
                  AND OLD.status = 'active' AND NEW.status = 'superseded'
                  AND EXISTS (
                    SELECT 1 FROM public.documents d
                     WHERE d.org_id = OLD.org_id AND d.id = OLD.invoice_id
                       AND d.status = 'draft'
                  )))
     OR NOT (NEW.status = OLD.status OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'rating run evidence is immutable except for superseding or clearing a deleted draft invoice';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_rating_runs_transition_guard
  BEFORE INSERT OR UPDATE ON public.usage_rating_runs
  FOR EACH ROW EXECUTE FUNCTION public.usage_rating_runs_transition_guard();

COMMENT ON TABLE public.usage_rating_runs IS
  'Immutable usage rating inputs and outputs linked to their generated invoice.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('usage_rating_runs', '0427_usage_rating_runs')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
