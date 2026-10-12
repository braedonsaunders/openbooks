-- Preserve existing objects when a pending migration encounters an unrecorded schema.
WITH existing_objects AS (
  SELECT 'table public.' || c.relname AS subject FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('recognition_control_events')
  UNION ALL
  SELECT 'function public.' || p.proname AS subject FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('recognition_control_immutable', 'fair_value_used_policy_guard')
  UNION ALL
  SELECT 'column public.fair_value_prices.' || a.attname AS subject FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.fair_value_prices'::regclass AND NOT a.attisdropped AND a.attname IN ('calculation_method', 'formula_percent', 'list_price', 'unit_cost')
  UNION ALL
  SELECT 'column public.performance_obligations.' || a.attname AS subject FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.performance_obligations'::regclass AND NOT a.attisdropped AND a.attname IN ('recognition_held', 'hold_reason', 'control_revision', 'delivered_on', 'delivery_bundle_document_id', 'allocation_basis')
)
SELECT '0695.existing_objects' AS code, 'refuse' AS severity, subject,
 'Schema objects already exist for this pending migration.' AS detail,
 'Preserve the objects and tenant data; compare all affected definitions with the published migration and obtain database-owner approval for reconciliation before retrying.' AS remedy
FROM existing_objects
UNION ALL
SELECT '0695.negative_fair_value' AS code, 'refuse' AS severity, 'fair-value price ' || id::text AS subject,
 'An existing fixed fair-value price is negative and cannot satisfy the new policy constraint.' AS detail,
 'Review the dated price through native fair-value configuration and preserve obligations already priced by it before retrying.' AS remedy
FROM public.fair_value_prices WHERE unit_price < 0;
