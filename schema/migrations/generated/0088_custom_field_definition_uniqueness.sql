-- OpenBooks forward migration 0088_custom_field_definition_uniqueness.
-- Serialize the preflight and index installation with definition writes.
-- Definitions address values by key: never rename, merge or discard a legacy
-- collision automatically, because doing so can reinterpret historical data.
LOCK TABLE public.custom_field_defs IN SHARE ROW EXCLUSIVE MODE;

DO $custom_field_scope_preflight$
DECLARE
  collision record;
BEGIN
  SELECT org_id, target_table, coalesce(target_kind, '') AS kind_scope, key,
         array_agg(id ORDER BY id) AS row_ids
    INTO collision
    FROM public.custom_field_defs
   GROUP BY org_id, target_table, coalesce(target_kind, ''), key
  HAVING count(*) > 1
   ORDER BY org_id, target_table, coalesce(target_kind, ''), key
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'custom-field uniqueness migration found duplicate definitions',
      DETAIL = format('org=%s table=%s kind=%s key=%s ids=%s', collision.org_id,
                      collision.target_table, collision.kind_scope, collision.key, collision.row_ids),
      HINT = 'Reconcile these definitions under a reviewed data-preserving repair, then rerun the migration.';
  END IF;
END
$custom_field_scope_preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS custom_field_defs_scope_key_unique
  ON public.custom_field_defs (org_id, target_table, coalesce(target_kind, ''), key);

COMMENT ON INDEX public.custom_field_defs_scope_key_unique IS
  'openbooks:custom_field_definition_uniqueness:v1 - one definition per tenant, table, normalized kind and key, including inactive definitions';
