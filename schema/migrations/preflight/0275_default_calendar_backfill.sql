-- OpenBooks upgrade preflight for 0275_default_calendar_backfill.
--
-- Read-only mirror of the migration's two refusals: a tie for first place
-- on both usage and age cannot be resolved by the deterministic rule, and
-- an org whose calendars are all inactive has nothing safe to promote.
-- Zero rows means 0275 will promote exactly one active default per org.
SELECT * FROM (
SELECT '0275.ambiguous_calendar' AS code,
        'refuse' AS severity,
        format('org %s has tied active calendars that usage and age cannot order', r1.org_id) AS subject,
        format('two active calendars tie for first on period count (%s) and creation time (%s). The backfill refuses to guess',
               r1.period_count, r1.created_at) AS detail,
        'Promote one default per org from the close calendars screen first, then re-apply.' AS remedy
   FROM (SELECT c.org_id,
                COUNT(p.id) AS period_count,
                c.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY c.org_id
                  ORDER BY COUNT(p.id) DESC, c.created_at ASC, c.id ASC) AS rn
           FROM public.fiscal_calendars c
           LEFT JOIN public.accounting_periods p
             ON p.fiscal_calendar_id = c.id AND p.org_id = c.org_id
          WHERE c.is_active
            AND EXISTS (SELECT 1 FROM public.fiscal_calendars t
                         WHERE t.org_id = c.org_id AND t.is_active)
            AND NOT EXISTS (SELECT 1 FROM public.fiscal_calendars d
                             WHERE d.org_id = c.org_id AND d.is_default AND d.is_active)
          GROUP BY c.org_id, c.id, c.created_at) r1
   JOIN (SELECT c.org_id,
                COUNT(p.id) AS period_count,
                c.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY c.org_id
                  ORDER BY COUNT(p.id) DESC, c.created_at ASC, c.id ASC) AS rn
           FROM public.fiscal_calendars c
           LEFT JOIN public.accounting_periods p
             ON p.fiscal_calendar_id = c.id AND p.org_id = c.org_id
          WHERE c.is_active
            AND EXISTS (SELECT 1 FROM public.fiscal_calendars t
                         WHERE t.org_id = c.org_id AND t.is_active)
            AND NOT EXISTS (SELECT 1 FROM public.fiscal_calendars d
                             WHERE d.org_id = c.org_id AND d.is_default AND d.is_active)
          GROUP BY c.org_id, c.id, c.created_at) r2
     ON r2.org_id = r1.org_id AND r2.rn = 2
  WHERE r1.rn = 1
    AND r2.period_count = r1.period_count
    AND r2.created_at = r1.created_at
  ORDER BY r1.org_id
  LIMIT 20) ambiguous_orgs
UNION ALL
SELECT * FROM (
SELECT '0275.inactive_calendars' AS code,
        'refuse' AS severity,
        format('org %s holds periods but every fiscal calendar is inactive', c.org_id) AS subject,
        format('org %s has accounting periods and no active calendar, so no default can post', c.org_id) AS detail,
        'Reactivate one calendar per org from the close screen first, then re-apply.' AS remedy
   FROM (SELECT DISTINCT c.org_id
           FROM public.fiscal_calendars c
          WHERE NOT EXISTS (SELECT 1 FROM public.fiscal_calendars a
                             WHERE a.org_id = c.org_id AND a.is_active)
            AND EXISTS (SELECT 1 FROM public.accounting_periods p
                         WHERE p.org_id = c.org_id)) c
  ORDER BY c.org_id
  LIMIT 20) inactive_orgs;
