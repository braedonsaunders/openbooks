-- OpenBooks forward migration 0386_storage_cleanup_outbox.
-- Durable, retryable ownership for S3 objects pending cleanup: every S3
-- delete path enqueues its object key in the same transaction as the row
-- delete (or, where no row delete exists, as a standalone durable intent),
-- and a worker duty drains the queue with claim-expiry reclaim. Inline
-- best-effort deletes stay where they are; this table is the backstop that
-- survives crashes, rollbacks, and partial S3 DeleteObjects responses.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.storage_cleanup_outbox (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    object_key text NOT NULL,
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_cleanup_outbox_owner_kind CHECK ((owner_kind = ANY (ARRAY['file_version'::text, 'file_version_copy'::text, 'email_attachment'::text]))),
    CONSTRAINT storage_cleanup_outbox_nonnegative_attempts CHECK ((attempts >= 0))
);

ALTER TABLE ONLY public.storage_cleanup_outbox FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'storage_cleanup_outbox_pkey'
  ) THEN
    ALTER TABLE ONLY public.storage_cleanup_outbox
      ADD CONSTRAINT storage_cleanup_outbox_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS storage_cleanup_outbox_object_key
  ON public.storage_cleanup_outbox USING btree (object_key);
CREATE INDEX IF NOT EXISTS storage_cleanup_outbox_due
  ON public.storage_cleanup_outbox USING btree (next_attempt_at, claimed_at);
CREATE INDEX IF NOT EXISTS storage_cleanup_outbox_owner
  ON public.storage_cleanup_outbox USING btree (owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS storage_cleanup_outbox_org
  ON public.storage_cleanup_outbox USING btree (org_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'storage_cleanup_outbox_org_fk'
  ) THEN
    ALTER TABLE ONLY public.storage_cleanup_outbox
      ADD CONSTRAINT storage_cleanup_outbox_org_fk
      FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'storage_cleanup_outbox'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.storage_cleanup_outbox
      USING (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR (
          (org_id IS NOT NULL)
          AND ((org_id)::text = current_setting('app.current_org'::text, true))
        )
      )
      WITH CHECK (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR (
          (org_id IS NOT NULL)
          AND ((org_id)::text = current_setting('app.current_org'::text, true))
        )
      );
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.storage_cleanup_outbox IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.storage_cleanup_outbox IS
  'Durable retry ledger for S3 objects whose owner committed a deletion or staged a recoverable write.';
