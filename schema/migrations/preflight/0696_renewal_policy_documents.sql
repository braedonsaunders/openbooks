-- Preserve existing objects when a pending migration encounters an unrecorded schema.
WITH existing_objects AS (
  SELECT 'table public.' || c.relname AS subject FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('subscription_renewal_policies', 'subscription_renewal_occurrences')
  UNION ALL
  SELECT 'function public.' || p.proname AS subject FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('renewal_policy_guard')
  UNION ALL
  SELECT 'constraint public.notifications.' || c.conname AS subject FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.notifications'::regclass AND c.conname='notifications_renewal_org_id_id'
)
SELECT '0696.existing_objects' AS code, 'refuse' AS severity, subject,
 'Schema objects already exist for this pending migration.' AS detail,
 'Preserve the objects and tenant data; compare all affected definitions with the published migration and obtain database-owner approval for reconciliation before retrying.' AS remedy
FROM existing_objects;
