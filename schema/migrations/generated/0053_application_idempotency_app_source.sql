-- OpenBooks forward migration 0053_application_idempotency_app_source.
--
-- application_idempotency_keys is the app-wide exactly-once registry: every
-- mutating command claims a row there and the stored response replays for
-- retries after a lost HTTP result, so one logical invocation can never move
-- money twice. Its source CHECK previously admitted only 'api', 'mcp', and
-- 'assistant'.
--
-- Sandboxed App backends were writing financial effects OUTSIDE that
-- contract: ob.journal.create went straight to its own committing adapter,
-- the run-evidence app_rows insert was best-effort in a trailing try/catch,
-- and a retry after a throw/timeout re-executed the very same writes. App
-- invocations now claim keys here before any financial write and commit their
-- effects together with their audit row (see engine/src/apps-invocations.ts
-- and web/lib/apps/store.ts), so this migration admits them as first-class
-- users of the shared registry with source 'app'.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.application_idempotency_keys
  DROP CONSTRAINT application_idempotency_keys_source_check;

ALTER TABLE public.application_idempotency_keys
  ADD CONSTRAINT application_idempotency_keys_source_check
    CHECK (source = ANY (ARRAY['api'::text, 'mcp'::text, 'assistant'::text, 'app'::text]));

COMMENT ON CONSTRAINT application_idempotency_keys_source_check ON public.application_idempotency_keys IS
  'openbooks:application_idempotency_keys.source:v2 - trusted invocation surfaces that claim exactly-once keys here; ''app'' covers sandboxed App backend endpoints and App platform bridge mutations';
