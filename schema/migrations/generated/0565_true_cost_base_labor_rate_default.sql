-- OpenBooks forward migration 0565_true_cost_base_labor_rate_default.
-- Profiles saved through the old persistMoney default carry baseLaborRate
-- '50.0000' the operator never typed: any save that left the rate empty
-- persisted the default, so the value is evidence of the default, not of a
-- decision. Clearing it returns the profile to the honest unset state, where
-- the True Cost loader refuses by name and points at the base-rate input.
-- Only default-carrying profiles with no audit evidence of an operator
-- writing the value are cleared; anything ambiguous is left untouched and
-- reported by the preflight instead.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- A profile carries the old default when its baseLaborRate is exactly
-- '50.0000'. Audit evidence of an operator writing the value is an audit_log
-- row for the org whose changes mention a true-cost config write carrying
-- baseLaborRate 50.0000. The True Cost config endpoint persists
-- orgs.settings directly and writes no such rows today, so the predicate
-- below protects any past or future audited write (support edit, later code
-- path) while clearing the unaudited defaults. One statement: every CTE reads
-- the pre-migration snapshot, so the audit insert sees the values the update
-- cleared.
WITH candidates AS (
  SELECT o.id AS org_id, p.elem ->> 'id' AS profile_id,
    coalesce(p.elem ->> 'name', p.elem ->> 'id') AS profile_name
  FROM public.orgs o,
    LATERAL jsonb_array_elements(
      o.settings -> 'analytics' -> 'trueCost' -> 'profiles'
    ) WITH ORDINALITY AS p(elem, ord)
  WHERE jsonb_typeof(o.settings -> 'analytics' -> 'trueCost' -> 'profiles') = 'array'
    AND p.elem ->> 'baseLaborRate' = '50.0000'
    AND p.elem ->> 'id' IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.audit_log a
      WHERE a.org_id = o.id
        AND a.changes::text LIKE '%baseLaborRate%'
        AND a.changes::text LIKE '%50.0000%'
    )
),
rebuilt AS (
  SELECT o.id AS org_id, jsonb_agg(
    CASE WHEN EXISTS (
        SELECT 1 FROM candidates c
        WHERE c.org_id = o.id AND c.profile_id = (p.elem ->> 'id'))
      THEN p.elem || '{"baseLaborRate": ""}'::jsonb
      ELSE p.elem END
    ORDER BY p.ord) AS profiles
  FROM public.orgs o,
    LATERAL jsonb_array_elements(
      o.settings -> 'analytics' -> 'trueCost' -> 'profiles'
    ) WITH ORDINALITY AS p(elem, ord)
  WHERE EXISTS (SELECT 1 FROM candidates c WHERE c.org_id = o.id)
  GROUP BY o.id
),
updated AS (
  UPDATE public.orgs o
  SET settings = jsonb_set(
    o.settings, '{analytics,trueCost,profiles}', rebuilt.profiles, true)
  FROM rebuilt
  WHERE o.id = rebuilt.org_id
  RETURNING o.id AS org_id
)
-- One audit row per changed org: actor null (system migration), the
-- before/after of exactly the cleared key per profile, and the reason.
INSERT INTO public.audit_log (org_id, table_name, row_id, action, actor_id, changes)
SELECT c.org_id, 'orgs', c.org_id, 'update', NULL,
  jsonb_build_object(
    'before', jsonb_object_agg(c.profile_id, jsonb_build_object('baseLaborRate', '50.0000')),
    'after', jsonb_object_agg(c.profile_id, jsonb_build_object('baseLaborRate', '')),
    'reason', 'retired default base rate cleared; re-enter a deliberate value in True Cost configuration')
FROM candidates c
JOIN updated u ON u.org_id = c.org_id
GROUP BY c.org_id;
