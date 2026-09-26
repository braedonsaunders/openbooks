-- OpenBooks upgrade preflight for 0414_direct_post_idempotency_key.
--
-- Read-only mirror of the migration's duplicate-key refusal: the partial
-- unique index cannot be installed while two entries of one organization
-- carry the same direct-post idempotency key. Zero rows means ready
-- for 0414.
SELECT '0414.duplicate_idempotency_key' AS code,
       'refuse' AS severity,
       format('journal_entries holds %s entries of org %s with idempotency key %s',
              dupes.n, dupes.org_id, dupes.k) AS subject,
       format('direct-post idempotency keys must be unique per organization; %s rows share this key',
              dupes.n) AS detail,
       'Give each entry its own idempotency key before installing 0414.' AS remedy
  FROM (
    SELECT org_id, custom->>'idempotencyKey' AS k, count(*) AS n
      FROM public.journal_entries
     WHERE custom ? 'idempotencyKey'
     GROUP BY org_id, custom->>'idempotencyKey'
    HAVING count(*) > 1
  ) dupes
 ORDER BY dupes.org_id, dupes.k
 LIMIT 20;
