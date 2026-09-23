-- OpenBooks forward migration 0306_account_group_default_backfill.
--
-- The True Cost report classifies the GL through the `cost_pool` (notably
-- `direct_labor`) and `burden` account-group dimensions, but those defaults
-- used to be seeded only by a hand-run script against the oldest org: every
-- other org opened True Cost with no groups, so all labour read as burden
-- and every expense account surfaced as "Unassigned". This backfills the
-- missing defaults for every org. New orgs are covered going forward by
-- org provisioning (ensureAccountGroupDefaults); this migration is the
-- same insert-missing guarantee for pre-existing tenants.
--
-- INSERT-MISSING ONLY. A row whose (org_id, dimension, key) already exists
-- is left exactly as the tenant left it: a customized match rule is never
-- reverted and a deactivated group is never reactivated. The `on conflict
-- do nothing` below is that guarantee, not a convenience — the old seeder
-- refreshed defaults in place, so re-running it silently erased operator
-- classification policy. A genuine "reset to defaults" stays an explicit
-- per-group admin edit (audited), never a side effect of a seed.
--
-- The literals below are a frozen snapshot of DEFAULT_ACCOUNT_GROUPS in
-- schema/src/account-groups.ts, which is the live source of truth for every
-- future seed. Re-runnable: a second run inserts nothing.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

INSERT INTO public.account_groups (org_id, dimension, key, name, color, sort_order, match, is_catch_all)
SELECT o.id, d.dimension, d.key, d.name, d.color, d.sort_order, d.match, d.is_catch_all
  FROM public.orgs o
 CROSS JOIN (VALUES
    ('cost_pool', 'direct_cost', 'Direct Cost', '#0d9488', 10, '{"accountTypes":["cogs"]}'::jsonb, false),
    ('cost_pool', 'direct_labor', 'Direct Labor', '#0ea5e9', 20, '{"namePattern":"\\b(wage|wages|labour|labor|payroll|salary|salaries|hourly|foreman|crew|journeyman|apprentice)\\b"}'::jsonb, false),
    ('cost_pool', 'overhead', 'Overhead', '#8b5cf6', 30, '{"namePattern":"overhead|indirect|rent|lease|utilit|hydro|electric|gas|telephone|internet|deprec|amort|repair|maintenance|supplies|shop|vehicle|fuel|equipment|tools|freight|training|safety|uniform|licens|permit|dues|subscription|software|bank charge|interest"}'::jsonb, false),
    ('cost_pool', 'g_and_a', 'G&A', '#f59e0b', 40, '{"namePattern":"admin|administrat|executive|office|professional fee|accounting|legal|management|rrsp|benefit|insurance|human resource"}'::jsonb, false),
    ('cost_pool', 'other', 'Other', '#94a3b8', 90, '{}'::jsonb, true),
    ('burden', 'facilities', 'Facilities', '#f59e0b', 10, '{"namePattern":"rent|property tax|building|premises|heat|hydro|utilit|electric power|water|waste|janitor|snow"}'::jsonb, false),
    ('burden', 'admin_wages', 'Admin & Salaries', '#3b82f6', 20, '{"namePattern":"office wages|management salar|executive salar|bonus|profit sharing|rrsp|ipp |severance|stat(utory)? holiday.*admin|short term disability|admin.*(wage|salar)"}'::jsonb, false),
    ('burden', 'insurance', 'Insurance', '#ef4444', 30, '{"namePattern":"insurance"}'::jsonb, false),
    ('burden', 'it_software', 'IT & Communications', '#8b5cf6', 40, '{"namePattern":"software|computer|communications|telephone|internet|website|it services"}'::jsonb, false),
    ('burden', 'fleet_equipment', 'Fleet & Equipment', '#10b981', 50, '{"namePattern":"vehicle|truck|fleet|fuel|equipment|deprec|amort|tenant improvement|r&m|repairs"}'::jsonb, false),
    ('burden', 'professional', 'Professional Fees', '#06b6d4', 60, '{"namePattern":"accounting|legal|consult|professional fee|audit"}'::jsonb, false),
    ('burden', 'people_safety', 'People & Safety', '#ec4899', 70, '{"namePattern":"ppe|safety|training|weld testing|recruit|membership|dues|permit|codes|meals|entertainment|promotional|travel|uniform"}'::jsonb, false),
    ('burden', 'financial', 'Financial', '#64748b', 80, '{"namePattern":"bank fee|interest|bad debt|exchange|penalt|provision for income tax"}'::jsonb, false)
  ) AS d (dimension, key, name, color, sort_order, match, is_catch_all)
-- Insert-missing by (org_id, dimension, key): an existing tenant row wins
-- over the default, so operator edits and deactivations survive this seed.
ON CONFLICT (org_id, dimension, key) DO NOTHING;
