-- OpenBooks upgrade preflight for 0440_connector_replay_authorization_guard.
--
-- An absent replay predicate is ready for installation. An existing one must
-- have the exact body 0440 installs. The journal guard may still be the
-- source-module-aware pre-branch definition; if replay authorization is
-- already present, only the exact 0440 body is safe to replace.
WITH expected AS (
  SELECT '30e83349531781e826cce792fa54a49f828b0d3667655870ecc11565f16653c3'::text AS authorization_body,
         'b04c5bd00429a773ddd89092376fd0be32740dcb545515c3848b70edd73e6778'::text AS guard_body
), guard_state AS (
  SELECT p.prosrc
    FROM pg_catalog.pg_proc p
   WHERE p.oid = pg_catalog.to_regprocedure('public.je_guard()')
)
SELECT '0440.unexpected_je_guard_body' AS code,
       'refuse' AS severity,
       'function public.je_guard()' AS subject,
       CASE
         WHEN g.prosrc IS NULL THEN 'public.je_guard() is missing'
         ELSE 'installed body digest: ' || pg_catalog.encode(public.digest(pg_catalog.convert_to(g.prosrc, 'UTF8'), 'sha256'), 'hex')
       END AS detail,
       'Review the live public.je_guard() definition and rebase 0440 before upgrading.' AS remedy
  FROM expected e
  LEFT JOIN guard_state g ON true
 WHERE g.prosrc IS NULL
    OR (g.prosrc LIKE '%openbooks_connector_replay_authorized%'
        AND pg_catalog.encode(public.digest(pg_catalog.convert_to(g.prosrc, 'UTF8'), 'sha256'), 'hex') <> e.guard_body)
    OR (g.prosrc NOT LIKE '%openbooks_connector_replay_authorized%'
        AND g.prosrc NOT LIKE '%v_module%')
UNION ALL
SELECT '0440.unexpected_authorization_predicate' AS code,
       'refuse' AS severity,
       'function public.openbooks_connector_replay_authorized(uuid, uuid, uuid)' AS subject,
       'installed body digest: ' || pg_catalog.encode(public.digest(pg_catalog.convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex') AS detail,
       'Review the live predicate body and rebase 0440 before upgrading.' AS remedy
  FROM pg_catalog.pg_proc p
  CROSS JOIN expected e
 WHERE p.oid = pg_catalog.to_regprocedure(
         'public.openbooks_connector_replay_authorized(uuid,uuid,uuid)'
       )
   AND pg_catalog.encode(public.digest(pg_catalog.convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex') <> e.authorization_body;
