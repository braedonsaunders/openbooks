-- OpenBooks upgrade preflight for 0339_depreciation_schedule_convention.
--
-- Read-only. 0339 stamps the first-period convention on schedule headers
-- that never recorded one, backfilled from the effective policy (book
-- policy, then asset, then category default), and records each stamped row
-- in upgrade_legacy_provenance. This preflight names the headers the
-- backfill will touch, using the migration's own predicate, mirrored here.
--
-- A preflight evaluates BEFORE its migration applies, so it cannot read
-- the column 0339 itself adds: unstamped headers are identified by the
-- absence of a 0339 provenance row, not by a NULL convention.
--
-- 0339.unrecorded_schedule_convention (notice): a schedule header with no
-- 0339 provenance row and a resolvable effective policy. No action
-- required; the upgrade stamps it and records the reconstruction. Zero
-- rows means the backfill touches nothing.
SELECT * FROM (
  SELECT '0339.unrecorded_schedule_convention' AS code,
         'notice' AS severity,
         format('depreciation_schedules %s (org %s, asset %s, book %s) records no convention; effective policy resolves %s', s.id, s.org_id, s.asset_id, s.book_id, eff.convention) AS subject,
         'Legacy schedule header predating convention capture; migration 0339 stamps the effective convention and records the row in upgrade_legacy_provenance.' AS detail,
         'No action required: the upgrade derives the convention deterministically from the effective book/asset/category policy.' AS remedy
    FROM public.depreciation_schedules s
    JOIN public.fixed_assets a
      ON a.org_id = s.org_id AND a.id = s.asset_id
    JOIN public.asset_categories c
      ON c.org_id = s.org_id AND c.id = a.category_id
    LEFT JOIN public.depreciation_book_policies p
      ON p.org_id = s.org_id AND p.book_id = s.book_id AND p.category_id = a.category_id
    JOIN LATERAL (
      SELECT COALESCE(p.convention, a.depreciation_convention, c.default_convention) AS convention
    ) eff ON true
   WHERE eff.convention IN ('full_month', 'mid_month', 'half_year')
     AND NOT EXISTS (
       SELECT 1 FROM public.upgrade_legacy_provenance u
        WHERE u.org_id = s.org_id
          AND u.migration = '0339_depreciation_schedule_convention'
          AND u.table_name = 'depreciation_schedules'
          AND u.row_id = s.id
     )
   ORDER BY s.org_id, s.asset_id
   LIMIT 50
) samples
UNION ALL
SELECT '0339.unrecorded_schedule_convention' AS code,
       'notice' AS severity,
       format('%s schedule header(s) will carry a backfilled convention from migration 0339', count(*)) AS subject,
       'Total across all organizations; the per-row findings above name the first 50.' AS detail,
       'No action required: the upgrade derives the convention deterministically from the effective book/asset/category policy.' AS remedy
  FROM public.depreciation_schedules s
  JOIN public.fixed_assets a
    ON a.org_id = s.org_id AND a.id = s.asset_id
  JOIN public.asset_categories c
    ON c.org_id = s.org_id AND c.id = a.category_id
  LEFT JOIN public.depreciation_book_policies p
    ON p.org_id = s.org_id AND p.book_id = s.book_id AND p.category_id = a.category_id
  JOIN LATERAL (
    SELECT COALESCE(p.convention, a.depreciation_convention, c.default_convention) AS convention
  ) eff ON true
 WHERE eff.convention IN ('full_month', 'mid_month', 'half_year')
   AND NOT EXISTS (
     SELECT 1 FROM public.upgrade_legacy_provenance u
      WHERE u.org_id = s.org_id
        AND u.migration = '0339_depreciation_schedule_convention'
        AND u.table_name = 'depreciation_schedules'
        AND u.row_id = s.id
   )
HAVING count(*) > 0;
