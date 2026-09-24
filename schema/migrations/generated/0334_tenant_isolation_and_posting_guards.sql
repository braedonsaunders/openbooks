-- OpenBooks forward migration 0334_tenant_isolation_and_posting_guards.
--
-- Audit wave G (database layer): the migration chain must isolate tenants
-- and fence posted history on its own, without relying on the bootstrap
-- environments.sql backstop that re-applies RLS to every org_id table at
-- boot. A scratch install from these files alone left three tenant tables
-- readable and writable across organizations, let posted documents regress
-- to draft, fenced amend-deletes softer than amend-updates, and left three
-- derived summaries able to drift behind their sources. Each section below
-- names its finding, makes the chain correct standalone, and stays
-- re-runnable: every statement tolerates re-execution.
--
-- Section 1 (G1/G2/G3): explicit tenant isolation.
-- 0026 gave scheduler_outbox_terminal_audit FORCE ROW LEVEL SECURITY plus
-- an org_isolation policy but never ENABLEd RLS, so PostgreSQL left
-- isolation inactive and a tenant session read and wrote every
-- organization's rows. 0153 did the same for ai_work_item_notes, and 0281
-- created hrm_exit_record_events (org_id NOT NULL) with no RLS at all.
-- This section ENABLEs + FORCEs all three and creates the standard
-- org_isolation policy wherever it is missing, byte-identical to the
-- backstop's openbooks:org_isolation:v1 so the bootstrap drift check stays
-- quiet.
--
-- Nullable-org decision (G1): scheduler_outbox_terminal_audit.org_id is
-- nullable because terminal scheduler evidence can exist before any tenant
-- scope is established (crash recovery, replay authorization). Those rows
-- are platform-only by construction: NULL never satisfies
-- org_id = current_setting('app.current_org'), so no tenant session can
-- read or write them with or without this section — only a bypass holder
-- (trusted server code) sees them, and only a bypass holder could have
-- inserted them (the WITH CHECK refuses a NULL org_id to any scoped
-- writer). No constraint change, no second policy: the decision is pinned
-- by schema/rls-catalog-governance.integration.test.ts instead.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Section 1 (G1/G2/G3): the chain isolates every tenant table standalone.
-- ---------------------------------------------------------------------------
ALTER TABLE public.scheduler_outbox_terminal_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.scheduler_outbox_terminal_audit FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'org_isolation'
       AND polrelid = 'public.scheduler_outbox_terminal_audit'::regclass
  ) THEN
    CREATE POLICY org_isolation ON public.scheduler_outbox_terminal_audit
      USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text)
              OR ((org_id)::text = current_setting('app.current_org'::text, true))))
      WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text)
              OR ((org_id)::text = current_setting('app.current_org'::text, true))));
    COMMENT ON POLICY org_isolation ON public.scheduler_outbox_terminal_audit
      IS 'openbooks:org_isolation:v1';
  END IF;
END
$$;

ALTER TABLE public.ai_work_item_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.ai_work_item_notes FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_work_item_notes' AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.ai_work_item_notes
      USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text)
              OR ((org_id)::text = current_setting('app.current_org'::text, true))))
      WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text)
              OR ((org_id)::text = current_setting('app.current_org'::text, true))));
    COMMENT ON POLICY org_isolation ON public.ai_work_item_notes
      IS 'openbooks:org_isolation:v1';
  END IF;
END
$$;

ALTER TABLE public.hrm_exit_record_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.hrm_exit_record_events FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'hrm_exit_record_events' AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.hrm_exit_record_events
      USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text)
              OR ((org_id)::text = current_setting('app.current_org'::text, true))))
      WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text)
              OR ((org_id)::text = current_setting('app.current_org'::text, true))));
    COMMENT ON POLICY org_isolation ON public.hrm_exit_record_events
      IS 'openbooks:org_isolation:v1';
  END IF;
END
$$;
