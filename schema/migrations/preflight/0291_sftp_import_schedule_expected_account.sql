-- OpenBooks upgrade preflight for 0291_sftp_import_schedule_expected_account.
--
-- Read-only NOTICE (migration bytes final; the fix is app-only): every
-- active schedule for an identifying format (anything but CSV) with no
-- bound account refuses each identified statement after the upgrade until
-- someone binds it; the scheduler raises a named first-pass notice per
-- schedule and the UI reads 'Paused: expected account not set'. Predicate
-- owned by m73 (fix ed8e48205, code 0291.unbound_schedule NOTICE):
-- schedule sc.is_active AND sc.format <> 'csv' (format is text NOT NULL
-- DEFAULT 'auto', so a plain <> is exact — CSV-only routes never refuse
-- and must not notice), server sv.is_active via the sftp_servers join in
-- the same org, binding-null half vacuous pre-0291 (correct to document
-- without referencing the column), org on the single Features switchboard
-- path coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)
-- with the env conjunct o.env_kind = 'production'. Post-0291 every row
-- matching this scope has NULL binding (no backfill), so the pre-upgrade
-- count IS the post-upgrade notice count; the runtime notice and UI badge
-- take over from there. Zero rows means no schedule will pause. Accounts
-- are never auto-assigned.
SELECT '0291.unbound_schedule' AS code,
       'notice' AS severity,
       format('sftp_import_schedule %s (org %s) watches server %s for %s statements with no bound account',
              sc.id, sc.org_id, sv.name, sc.format) AS subject,
       format('schedule %s (format %s) on active server %s in a production bankFeeds-on org will refuse every identified statement after the upgrade until bound; the scheduler raises a named notice and the UI reads ''Paused: expected account not set''',
              sc.id, sc.format, sv.name) AS detail,
       'Bind the expected bank account per schedule in Company Settings → Bank Feeds before statements arrive; CSV schedules need no action. Accounts are never auto-assigned.' AS remedy
  FROM public.sftp_import_schedules sc
  JOIN public.sftp_servers sv
    ON sv.id = sc.sftp_server_id
   AND sv.org_id = sc.org_id
   AND sv.is_active
  JOIN public.orgs o
    ON o.id = sc.org_id
 WHERE sc.is_active
   AND sc.format <> 'csv'
   AND o.env_kind = 'production'
   AND coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)
 ORDER BY sc.org_id, sc.id
 LIMIT 20;
