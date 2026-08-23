-- OpenBooks forward migration 0005_posting_effects.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- postDocument used to run obligations/inventory after the posting
-- transaction committed. A crash in that window left a posted journal with
-- no durable retry. This table is the outbox: insert inside the posting
-- transaction, drain after commit, and let a worker call
-- runPostDocumentEffects if the process dies.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.posting_effects (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    document_id uuid NOT NULL,
    kind text NOT NULL,
    entry_id uuid NOT NULL,
    posting_date date NOT NULL,
    actor_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    finished_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT posting_effects_status CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT posting_effects_nonnegative_attempts CHECK ((attempt_count >= 0)),
    CONSTRAINT posting_effects_kind CHECK ((length(btrim(kind)) > 0))
);

ALTER TABLE ONLY public.posting_effects FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'posting_effects_pkey'
  ) THEN
    ALTER TABLE ONLY public.posting_effects
      ADD CONSTRAINT posting_effects_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS posting_effects_document
  ON public.posting_effects USING btree (document_id);
CREATE INDEX IF NOT EXISTS posting_effects_due
  ON public.posting_effects USING btree (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS posting_effects_org
  ON public.posting_effects USING btree (org_id, status, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'posting_effects_org_fk'
  ) THEN
    ALTER TABLE ONLY public.posting_effects
      ADD CONSTRAINT posting_effects_org_fk
      FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'posting_effects_document_fk'
  ) THEN
    ALTER TABLE ONLY public.posting_effects
      ADD CONSTRAINT posting_effects_document_fk
      FOREIGN KEY (document_id) REFERENCES public.documents(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'posting_effects_entry_fk'
  ) THEN
    ALTER TABLE ONLY public.posting_effects
      ADD CONSTRAINT posting_effects_entry_fk
      FOREIGN KEY (entry_id) REFERENCES public.journal_entries(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'posting_effects'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.posting_effects
      USING (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      )
      WITH CHECK (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      );
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.posting_effects IS 'openbooks:org_isolation:v1';

ALTER TABLE public.posting_effects ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.posting_effects IS
  'Durable posting-effects outbox. Insert inside the posting transaction; drain after commit via runPostDocumentEffects.';
