-- OpenBooks forward migration 0152_ai_conversation_memory.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The assistant's rolling conversation summary (assistant shard b07) needs a
-- home for `{ text, entities, turnsCovered, updatedAt }` per thread: a short
-- paragraph plus the party/account/project/document ids the user already
-- referred to, injected into later turns instead of the raw old transcript.
-- A metadata home on the conversation row keeps the summary owner-scoped by
-- construction (every accessor already filters org_id + user_id) and avoids
-- polluting the ai_messages window the model consumes.
--
-- Additive, ledger-tracked, no history reinterpretation: one nullable-input
-- jsonb column defaulting to '{}', no row or trigger changes. RLS is
-- unchanged — ai_conversations already carries the org_isolation policy
-- (USING/WITH CHECK on org_id), which governs the new column with the row.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.ai_conversations
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_conversations.metadata IS
  'Assistant conversation memory (shard b07): rolling summary { text, entities, turnsCovered, updatedAt }. Owner-scoped with the row; never shared across users.';
