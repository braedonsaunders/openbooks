-- OpenBooks forward migration 0650_statement_batch_runs.
--
-- Batched customer statements ("send statements to customers with a
-- balance"): statement_batch_runs records who created the batch, when, for
-- which period, and with which filters; statement_batch_items records one
-- row per customer with its resolved mailbox and delivery state
-- (queued/sending/sent/failed/skipped). The (run_id, party_id) uniqueness
-- is the idempotency guard that stops a retried job from sending twice.
--
-- No data or backfill: new tables, empty on arrival. Reapply-safe by
-- construction (create-if-absent objects only).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.statement_batch_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    period_from date,
    period_to date NOT NULL,
    filters jsonb NOT NULL DEFAULT '{}'::jsonb,
    recipient_count integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'queued',
    authorization_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT statement_batch_runs_pkey PRIMARY KEY (id),
    CONSTRAINT statement_batch_runs_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT statement_batch_runs_status CHECK (status IN ('queued', 'sending', 'done')),
    CONSTRAINT statement_batch_runs_recipient_count CHECK (recipient_count >= 0),
    CONSTRAINT statement_batch_runs_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT statement_batch_runs_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
    CONSTRAINT statement_batch_runs_updated_by_fkey FOREIGN KEY (updated_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE
);

CREATE INDEX statement_batch_runs_org_created ON public.statement_batch_runs (org_id, created_at DESC);

ALTER TABLE ONLY public.statement_batch_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.statement_batch_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.statement_batch_runs
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.statement_batch_runs IS 'openbooks:org_isolation:v1';

-- The tenant retirement fence only reaches tables present when 0626 ran:
-- attach it here, create-if-absent, so a fresh install fences this table
-- exactly like the coordinated lane (the 0643 late-tables shape).
DO $fences$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'statement_batch_runs' AND t.tgname = 'tenant_retirement_fence') THEN
  EXECUTE 'CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.statement_batch_runs FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()';
 END IF;
END $fences$;

CREATE TABLE public.statement_batch_items (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_id uuid NOT NULL,
    party_id uuid NOT NULL,
    to_email text,
    balance numeric(19, 4) NOT NULL DEFAULT 0,
    overdue numeric(19, 4) NOT NULL DEFAULT 0,
    currency_code text,
    status text NOT NULL DEFAULT 'queued',
    error text,
    delivery_key text,
    email_log_id uuid,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT statement_batch_items_pkey PRIMARY KEY (id),
    CONSTRAINT statement_batch_items_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT statement_batch_items_run_party_unique UNIQUE (run_id, party_id),
    CONSTRAINT statement_batch_items_status CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
    CONSTRAINT statement_batch_items_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT statement_batch_items_run_id_fkey FOREIGN KEY (org_id, run_id)
      REFERENCES public.statement_batch_runs(org_id, id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT statement_batch_items_party_id_fkey FOREIGN KEY (org_id, party_id)
      REFERENCES public.parties(org_id, id) DEFERRABLE,
    CONSTRAINT statement_batch_items_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
    CONSTRAINT statement_batch_items_updated_by_fkey FOREIGN KEY (updated_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE
);

CREATE INDEX statement_batch_items_org_run ON public.statement_batch_items (org_id, run_id);
CREATE UNIQUE INDEX statement_batch_items_delivery_key ON public.statement_batch_items (delivery_key) WHERE delivery_key IS NOT NULL;

ALTER TABLE ONLY public.statement_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.statement_batch_items FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.statement_batch_items
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.statement_batch_items IS 'openbooks:org_isolation:v1';

DO $fences$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'statement_batch_items' AND t.tgname = 'tenant_retirement_fence') THEN
  EXECUTE 'CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.statement_batch_items FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()';
 END IF;
END $fences$;

SELECT public.openbooks_refresh_query_catalog();
