SELECT '0731.actor_identity_lock_exists'::text AS code, 'refuse'::text AS severity,
  'public.lock_actor_home_identity(uuid,uuid,uuid)'::text AS subject,
  'An actor identity lock function exists without this migration being recorded.'::text AS detail,
  'Preserve the function and compare its owner, signature, body, privileges and invoker authority with the published migration before reconciliation.'::text AS remedy
WHERE to_regprocedure('public.lock_actor_home_identity(uuid,uuid,uuid)') IS NOT NULL;
