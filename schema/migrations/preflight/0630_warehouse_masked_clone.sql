-- Preserve unknown copy contracts; only the published warehouse source proof is replaced.
WITH findings AS (
 SELECT '0630.warehouse_copy_contract_mismatch'::text code,'public.warehouse_execution_clone_row_matches'::text subject,
  'The installed warehouse copy proof differs from its published definition.'::text detail,
  'Preserve the function and tenant history. Reconcile the published warehouse migration with the database owner before upgrading.'::text remedy
 WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname='warehouse_execution_clone_row_matches'
  AND pg_get_function_identity_arguments(p.oid)='relation text, candidate jsonb'
  AND md5(p.prosrc)='da99dde297f854bea89d35d65d48d29b' AND NOT p.prosecdef AND l.lanname='plpgsql'
  AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=public, pg_catalog']::text[])
 UNION ALL
 SELECT '0630.mask_function_collision','public.warehouse_execution_mask_json',
  'A warehouse masking function already exists without this migration receipt.',
  'Preserve the function and compare its complete definition with the database owner; do not replace an unregistered object.'
 WHERE EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='warehouse_execution_mask_json')
)
SELECT code,subject,detail,remedy FROM findings ORDER BY code,subject;
