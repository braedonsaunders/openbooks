-- OpenBooks forward migration 0029_sftp_username_global_unique.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction).
--
-- Audit finding: the SFTP daemon routes a login to a tenant solely via
-- sftp_servers.username (`SELECT ... WHERE username = $1 AND is_active`), but
-- the schema only carried a NON-unique index on that column while creation
-- minted the name from a 3-byte random suffix with no conflict handling. Two
-- organizations could therefore hold the same global login name, and the
-- daemon's `LIMIT 1` lookup would route authentication to an arbitrary one of
-- them — denying a legitimate tenant access to another tenant's filesystem
-- namespace.
--
-- A username is not per-tenant data: it IS the global login identity the one
-- shared listener resolves. This migration makes that identity unique in
-- storage, so every writer — API, import, and direct SQL alike — fails closed
-- instead of leaving routing ambiguous. Rollout never picks a winning
-- duplicate: if legacy data already collides, the preflight names the exact
-- rows and refuses to proceed until a human records which login is
-- authoritative (renaming one side is an audited product action, not a guess
-- this migration is allowed to make).

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $sftp_username_global_preflight$
DECLARE
  violation record;
BEGIN
  SELECT * INTO violation
    FROM (
      SELECT s.username AS login_name,
             (array_agg(s.id ORDER BY s.id))::text[] AS row_ids,
             (array_agg(s.org_id ORDER BY s.id))::text[] AS org_ids
        FROM public.sftp_servers s
       GROUP BY s.username
      HAVING count(*) > 1
    ) duplicates
   ORDER BY login_name
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format('legacy sftp_servers rows duplicate the global login name: %s', violation.login_name),
      DETAIL = jsonb_build_object(
        'username', violation.login_name,
        'row_ids', violation.row_ids,
        'org_ids', violation.org_ids
      )::text,
      HINT = 'Review the identified logins, rename every losing row (audited), and retry migration 0029. This migration never picks a winning duplicate: the daemon would route one of these tenants to the wrong filesystem.';
  END IF;
END
$sftp_username_global_preflight$;

-- The unique index replaces the plain lookup index on the same column; keeping
-- both would double every write's index maintenance for zero additional
-- reads. Partial uniqueness (is_active) is deliberately NOT used: a
-- deactivated login must keep its name reserved, otherwise reactivating an
-- old row could silently collide with a newer tenant's login.
DROP INDEX IF EXISTS public.sftp_servers_username;

CREATE UNIQUE INDEX IF NOT EXISTS sftp_servers_username_global
  ON public.sftp_servers USING btree (username);

COMMENT ON INDEX public.sftp_servers_username_global IS
  'openbooks:sftp_username_global_unique:v1 - the shared SFTP daemon routes a login to exactly one tenant row by username alone; the global unique index makes that routing deterministic and every other writer fails closed';
