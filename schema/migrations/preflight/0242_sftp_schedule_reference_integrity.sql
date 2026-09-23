-- OpenBooks upgrade preflight for 0242_sftp_schedule_reference_integrity.
--
-- Read-only mirror of the migration's own orphan precheck: a schedule whose
-- server or statement account is missing or lives in another organization
-- vanishes from the joined schedule list and can never run. Zero rows means
-- the install is ready for 0242.
SELECT * FROM (
SELECT '0242.orphan_server' AS code,
        'refuse' AS severity,
        format('sftp_import_schedule %s (org %s) names a server %s that is missing or owned by another organization',
               sc.id, sc.org_id, sc.sftp_server_id) AS subject,
        format('schedule %s references sftp_servers row %s, which does not exist or belongs to org %s',
               sc.id, sc.sftp_server_id, coalesce(sv.org_id::text, '(missing)')) AS detail,
        'Point the schedule at an SFTP server owned by the same organization, or delete the orphaned schedule, then re-apply. Migration 0242 will not rewrite schedule references.' AS remedy
   FROM public.sftp_import_schedules sc
   LEFT JOIN public.sftp_servers sv ON sv.id = sc.sftp_server_id
  WHERE sv.id IS NULL OR sv.org_id IS DISTINCT FROM sc.org_id
  ORDER BY sc.id
  LIMIT 20) orphan_servers
UNION ALL
SELECT * FROM (
SELECT '0242.orphan_account' AS code,
        'refuse' AS severity,
        format('sftp_import_schedule %s (org %s) names an account %s that is missing or owned by another organization',
               sc.id, sc.org_id, sc.account_id) AS subject,
        format('schedule %s references accounts row %s, which does not exist or belongs to org %s',
               sc.id, sc.account_id, coalesce(a.org_id::text, '(missing)')) AS detail,
        'Point the schedule at a bank account owned by the same organization, or delete the orphaned schedule, then re-apply. Migration 0242 will not rewrite schedule references.' AS remedy
   FROM public.sftp_import_schedules sc
   LEFT JOIN public.accounts a ON a.id = sc.account_id
  WHERE a.id IS NULL OR a.org_id IS DISTINCT FROM sc.org_id
  ORDER BY sc.id
  LIMIT 20) orphan_accounts;
