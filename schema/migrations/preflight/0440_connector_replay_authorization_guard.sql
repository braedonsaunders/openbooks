-- OpenBooks upgrade preflight for 0440_connector_replay_authorization_guard.
--
-- An absent replay predicate is ready for installation. An existing one must
-- have the exact body 0440 installs. The journal guard must be either the
-- source-module-aware body from 0405 or the replay-aware body 0440 installs.
-- 0440 depends on the authorization table from 0439. Reading it here also
-- defers this preflight on older bases until pending 0405 and 0439 migrations
-- have restored the guard and created the table.
WITH expected AS (
  SELECT '30e83349531781e826cce792fa54a49f828b0d3667655870ecc11565f16653c3'::text AS authorization_body,
         'a37008b2002f80373c69a0a4f1c1343845488cdf4c3511f00f749b0d2aa22ac3'::text AS predecessor_guard_body,
         'b04c5bd00429a773ddd89092376fd0be32740dcb545515c3848b70edd73e6778'::text AS installed_guard_body
   WHERE (SELECT pg_catalog.count(*) >= 0 FROM public.connector_replay_authorizations)
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
         ELSE 'installed body digest: ' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(g.prosrc, 'UTF8')), 'hex')
       END AS detail,
       'Review the live public.je_guard() definition and rebase 0440 before upgrading.' AS remedy
  FROM expected e
  LEFT JOIN guard_state g ON true
 WHERE g.prosrc IS NULL
    OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(g.prosrc, 'UTF8')), 'hex')
         NOT IN (e.predecessor_guard_body, e.installed_guard_body)
UNION ALL
SELECT '0440.unexpected_authorization_predicate' AS code,
       'refuse' AS severity,
       'function public.openbooks_connector_replay_authorized(uuid, uuid, uuid)' AS subject,
       'installed body digest: ' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS detail,
       'Review the live predicate body and rebase 0440 before upgrading.' AS remedy
  FROM pg_catalog.pg_proc p
  CROSS JOIN expected e
 WHERE p.oid = pg_catalog.to_regprocedure(
         'public.openbooks_connector_replay_authorized(uuid,uuid,uuid)'
       )
   AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') <> e.authorization_body;
