-- OpenBooks forward migration 0153_agent_workbench_assignment.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The Agent Workbench assigns findings to a user or role with a due date and
-- keeps a comment thread per finding. Three nullable columns on
-- ai_work_items plus a dedicated notes table (one row per comment — the
-- feedback table's one-row-per-user shape cannot hold a thread).
--
-- Additive, ledger-tracked, no history reinterpretation: new nullable
-- columns, one new table, indexes, and the standard org_isolation RLS
-- policy. Tenant isolation is unchanged.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.ai_work_items
  ADD COLUMN IF NOT EXISTS assignee_user_id uuid,
  ADD COLUMN IF NOT EXISTS assignee_role text,
  ADD COLUMN IF NOT EXISTS due_at timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_work_items_assignee_user_fkey'
  ) THEN
    ALTER TABLE public.ai_work_items
      ADD CONSTRAINT ai_work_items_assignee_user_fkey
      FOREIGN KEY (assignee_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ai_work_item_notes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    user_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_work_item_notes_body_check CHECK ((char_length(body) > 0 AND char_length(body) <= 4000))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_work_item_notes_work_item_fkey'
  ) THEN
    ALTER TABLE public.ai_work_item_notes
      ADD CONSTRAINT ai_work_item_notes_work_item_fkey
      FOREIGN KEY (work_item_id) REFERENCES public.ai_work_items(id) ON DELETE CASCADE DEFERRABLE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_work_item_notes_user_fkey'
  ) THEN
    ALTER TABLE public.ai_work_item_notes
      ADD CONSTRAINT ai_work_item_notes_user_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE DEFERRABLE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_work_item_notes_org_item_idx
  ON public.ai_work_item_notes USING btree (org_id, work_item_id, created_at, id);
CREATE INDEX IF NOT EXISTS ai_work_items_assignee_idx
  ON public.ai_work_items USING btree (org_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;

ALTER TABLE ONLY public.ai_work_item_notes FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_work_item_notes' AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.ai_work_item_notes USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));
  END IF;
END $$;

COMMENT ON POLICY org_isolation ON public.ai_work_item_notes IS 'openbooks:org_isolation:v1';
