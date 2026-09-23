-- OpenBooks upgrade preflight for 0319_account_group_single_active_catch_all.
--
-- Read-only mirror of what 0319 on main actually does (verified against
-- main's bytes; governing lines quoted). Preflights run BEFORE any
-- migration applies, so 0306 has not added the pristine default `other`
-- yet — the preflight anticipates 0306's insert instead of requiring the
-- pristine row to exist:
--
-- - NOTICE (cost_pool with at least one active tenant catch-all): 0306
--   will add the default `other` group at upgrade, so the scope will hold
--   both; 0319's repair deactivates the pristine default (UPDATE
--   is_active = false where key/name/color/sort/match equal the exact 0306
--   literals AND a sibling active catch-all exists) and the tenant group
--   stays authoritative. Cost_pool only: it is the one dimension whose
--   0306 seed set carries a catch-all (key 'other', sort 90).
-- - REFUSE (any dimension with two or more active tenant catch-alls):
--   deactivating the default cannot resolve two tenant groups, so 0319's
--   precheck (HAVING count(*) > 1 over ALL active catch-alls per
--   (org, dimension)) aborts the upgrade naming those scopes. This follows
--   the bytes, not m66's "pristine plus customs" carve-out text: with two
--   customs 0319 leaves a live conflict behind and aborts, so the
--   preflight refuses too. The spec-vs-bytes gap is flagged to m66; the
--   bytes rule.
--
-- Scopes with zero or one active catch-all, and dimensions 0306 adds no
-- default to, surface nothing; a scope that refuses never also notices, so
-- the "no action needed" notice can never contradict a refuse. Zero rows
-- means every scope already resolves.
WITH active_catch AS (
  SELECT org_id, dimension, key, name, color, sort_order, match
    FROM public.account_groups
   WHERE is_catch_all AND is_active
),
customs AS (
  SELECT org_id,
         dimension,
         count(*) AS custom_count,
         string_agg(key, ', ' ORDER BY sort_order, name) AS keys
    FROM active_catch
   WHERE NOT (key = 'other'
              AND name = 'Other'
              AND color = '#94a3b8'
              AND sort_order = 90
              AND match = '{}'::jsonb)
   GROUP BY org_id, dimension
)
SELECT * FROM (
SELECT '0319.multi_catch_all' AS code,
        'refuse' AS severity,
        format('org %s dimension %s holds %s active tenant catch-all groups', org_id, dimension, custom_count) AS subject,
        format('conflicting tenant catch-all keys: %s. The resolver takes the first by sort order and the rest are silently dead',
               keys) AS detail,
        'Deactivate all but the authoritative group per (org, dimension) before upgrade (keys to choose between are in parentheses above).' AS remedy
   FROM customs
  WHERE custom_count > 1
  ORDER BY org_id, dimension
  LIMIT 20) multi_scopes
UNION ALL
SELECT * FROM (
SELECT '0319.default_plus_custom' AS code,
        'notice' AS severity,
        format('org %s cost_pool holds tenant catch-all(s); 0306 will add the default other group', org_id) AS subject,
        format('tenant catch-all keys: %s. After 0306 adds the default other group the scope holds both; migration 0319 deactivates the default and the tenant catch-all stays authoritative',
               keys) AS detail,
        'No operator action needed: migration 0319 deactivates the default other group and keeps the tenant catch-all authoritative.' AS remedy
   FROM customs
  WHERE dimension = 'cost_pool'
    AND custom_count = 1
  ORDER BY org_id, dimension
  LIMIT 20) notice_scopes;
