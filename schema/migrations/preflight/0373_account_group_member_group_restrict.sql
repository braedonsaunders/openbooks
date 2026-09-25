SELECT
  'account_group_member_orphan' AS code,
  'notice' AS severity,
  m.id::text AS subject,
  'This historical account-group pin has no parent group; the migration preserves it and the new constraint will reject future orphans.' AS detail,
  'Restore the referenced account group if the historical classification must resolve; do not delete the pin as part of this upgrade.' AS remedy
FROM public.account_group_members m
LEFT JOIN public.account_groups g ON g.id = m.group_id
WHERE g.id IS NULL;
