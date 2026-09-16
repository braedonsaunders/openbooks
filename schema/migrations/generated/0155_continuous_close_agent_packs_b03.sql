-- OpenBooks forward migration 0155_continuous_close_agent_packs_b03.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The background-agent fleet (wave 2, shard b03) adds five detector packs —
-- forensics, tax, payroll, projects, cash — beside the original
-- accounting/finance agents and the wave-2 b02 packs (collections, payables,
-- reconciliation, hygiene, admitted by 0151). Policies, runs, and work items
-- for the new packs persist through the same three tables, whose
-- agent_key CHECK constraints still admit only the six keys 0151 widened to.
-- This migration widens exactly those three constraints to the full eleven
-- registered agent keys.
--
-- Additive and history-preserving: no rows are touched, existing rows keep
-- satisfying the widened predicate, and no finding, run, or policy is
-- reinterpreted. Tenant isolation is unchanged — ai_agent_policies,
-- ai_agent_runs, and ai_work_items already carry the org_isolation RLS
-- policy, so no policy mirroring is required.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.ai_agent_policies DROP CONSTRAINT IF EXISTS ai_agent_policies_agent_key_check;
ALTER TABLE public.ai_agent_policies ADD CONSTRAINT ai_agent_policies_agent_key_check CHECK ((agent_key = ANY (ARRAY['accounting'::text, 'finance'::text, 'collections'::text, 'payables'::text, 'reconciliation'::text, 'hygiene'::text, 'forensics'::text, 'tax'::text, 'payroll'::text, 'projects'::text, 'cash'::text])));

ALTER TABLE public.ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_agent_key_check;
ALTER TABLE public.ai_agent_runs ADD CONSTRAINT ai_agent_runs_agent_key_check CHECK ((agent_key = ANY (ARRAY['accounting'::text, 'finance'::text, 'collections'::text, 'payables'::text, 'reconciliation'::text, 'hygiene'::text, 'forensics'::text, 'tax'::text, 'payroll'::text, 'projects'::text, 'cash'::text])));

ALTER TABLE public.ai_work_items DROP CONSTRAINT IF EXISTS ai_work_items_agent_key_check;
ALTER TABLE public.ai_work_items ADD CONSTRAINT ai_work_items_agent_key_check CHECK ((agent_key = ANY (ARRAY['accounting'::text, 'finance'::text, 'collections'::text, 'payables'::text, 'reconciliation'::text, 'hygiene'::text, 'forensics'::text, 'tax'::text, 'payroll'::text, 'projects'::text, 'cash'::text])));
