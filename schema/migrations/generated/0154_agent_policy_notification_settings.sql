-- OpenBooks forward migration 0154_agent_policy_notification_settings.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Per-pack finding routing for the Agents setup area: who gets a pack's
-- findings (role/user ids) and how (findings_only | digest | immediate).
-- Nullable jsonb beside the existing detector/analysis settings; a null
-- value means findings-only. No sender reads it yet — findings always
-- surface under Agent Activity — so the column changes no runtime behaviour.
--
-- Additive, ledger-tracked, no history reinterpretation: column-only, no row
-- or trigger changes.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.ai_agent_policies
  ADD COLUMN IF NOT EXISTS notification_settings jsonb;
