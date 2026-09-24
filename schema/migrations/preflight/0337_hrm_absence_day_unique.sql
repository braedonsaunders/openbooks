-- Preflight for 0337_hrm_absence_day_unique: report the duplicate live
-- absence days the upgrade will grandfather rather than delete.
--
-- A notice row per (organization, employment, day) group where two or more
-- live rows (reversal_of IS NULL) cover the day: on upgrade each member is
-- marked is_pre_guard_legacy, exempt from the new day guard, preserved as
-- evidence in upgrade_legacy_provenance — and the calendar keeps netting
-- the combined hours until the day is corrected forward. Absence rows carry
-- no delete path, so no operator action can un-record a row: notices, never
-- refusals. Zero rows when every live day has exactly one row.

WITH live AS (
  SELECT a.org_id, a.employment_id, a.on_date, COUNT(*) AS rows
    FROM public.hrm_absences a
   WHERE a.reversal_of IS NULL
   GROUP BY a.org_id, a.employment_id, a.on_date
  HAVING COUNT(*) > 1
)
SELECT 'hrm_double_recorded_day' AS code,
       'notice' AS severity,
       format('employment %s', live.employment_id) AS subject,
       format('%s live absence rows cover %s; 0337 grandfathers the day as legacy and the calendar keeps netting the combined hours',
              live.rows, live.on_date) AS detail,
       'Review the day in the time records; if one row is wrong, correct it forward (the upgrade preserves, never deletes).' AS remedy
  FROM live
 ORDER BY live.on_date, live.employment_id;
