-- OpenBooks forward migration 0030_sftp_root_prefix_tenant_containment.
--
-- Audit finding fnd_mt98ab70_kset3i remediation: sftp_servers.root_prefix was
-- a tenant-selected physical location, stored verbatim. On the app-wide S3
-- bucket the storage resolver rooted every operation at that prefix, so an org
-- admin could read, write and delete a victim org's prefix with app
-- credentials; in local mode a `../` prefix could plant the virtual root
-- outside the SFTP data directory entirely.
--
-- This migration upgrades existing data fail-closed without destroying
-- anything:
--
--   1. A durable, inspectable conformance predicate: a root prefix conforms
--      only when it stays under its own org's tenant namespace (sftp/<orgId>/)
--      AND is a safe relative folder path (no backslashes, no percent-encoding,
--      no dot/empty segments).
--
--   2. Every pre-existing ACTIVE login whose prefix does not conform is
--      deactivated deterministically. The exact prior prefix is preserved
--      verbatim — on the row and in an append-only audit_log evidence record —
--      so nothing is deleted, rewritten or silently re-granted; an operator
--      recreates the login under the tenant namespace when remediation is
--      approved.
--
--   3. Storage enforcement mirrored in schema/src/banking.ts: a CHECK
--      constraint refuses escape shapes for every future writer. NOT VALID,
--      because the quarantined legacy rows must keep their exact prior prefix
--      as evidence; any UPDATE re-validates, so a quarantined login cannot be
--      reactivated without remediation.
--
--   4. A fail-closed verification: after this migration no ACTIVE login may
--      resolve outside its tenant namespace or carry an escape shape.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Keep the quarantine scan and the constraint install free of concurrent
-- writes. Bootstrap applies each reviewed migration inside one transaction, so
-- the lock remains held until the migration digest is recorded and committed.
LOCK TABLE public.sftp_servers IN SHARE ROW EXCLUSIVE MODE;

-- 1. The conformance predicate, persisted so quarantine, verification and any
-- operator review all test the exact same contract.
CREATE FUNCTION public.sftp_root_prefix_tenant_conforms(p_org_id uuid, p_root_prefix text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $sftp_root_prefix_tenant_conforms$
  SELECT p_root_prefix ~ ('^sftp/' || p_org_id::text || '(/|$)')
     AND p_root_prefix ~ '^[^/%]+(/[^/%]+)*$'
     AND p_root_prefix !~ '\\'
     AND p_root_prefix !~ '(^|/)\.\.?(/|$)'
$sftp_root_prefix_tenant_conforms$;

COMMENT ON FUNCTION public.sftp_root_prefix_tenant_conforms(uuid, text) IS
  'openbooks:sftp tenant containment — a root prefix conforms only when it stays under its own org''s sftp/<orgId>/ namespace and is a safe relative folder path (no backslash, no percent-encoding, no dot/empty segments).';

-- 2. Quarantine (never rewrite): ACTIVE logins whose root_prefix does not
-- conform are deactivated, with the exact prior prefix preserved in append-only
-- audit evidence. The CTE makes the evidence insert and the deactivation one
-- atomic unit.
WITH quarantined AS MATERIALIZED (
  SELECT s.id AS server_id,
         s.org_id,
         s.root_prefix,
         s.username
    FROM public.sftp_servers s
   WHERE s.is_active
     AND NOT public.sftp_root_prefix_tenant_conforms(s.org_id, s.root_prefix)
),
evidence AS (
  INSERT INTO public.audit_log (
    id,
    org_id,
    table_name,
    row_id,
    action,
    changes,
    actor_id,
    request_id
  )
  SELECT public.uuid_generate_v7(),
         q.org_id,
         'sftp_servers',
         q.server_id,
         'update',
         jsonb_build_object(
           'before', jsonb_build_object(
             'root_prefix', q.root_prefix,
             'is_active', true
           ),
           'after', jsonb_build_object(
             'root_prefix', q.root_prefix,
             'is_active', false
           ),
           'operation', 'sftp_root_prefix_tenant_containment_migration',
           'reason', 'root_prefix did not conform to the owning tenant namespace sftp/<orgId>/; the login was deactivated pending operator remediation',
           'remediation', 'recreate the SFTP server with a root prefix under sftp/' || q.org_id::text || '/; the prior prefix and its stored objects were left untouched',
           'migration', '0030_sftp_root_prefix_tenant_containment'
         ),
         NULL,
         'migration:0030_sftp_root_prefix_tenant_containment'
    FROM quarantined q
)
UPDATE public.sftp_servers s
   SET is_active = false,
       updated_at = now()
  FROM quarantined q
 WHERE s.id = q.server_id
   AND s.org_id = q.org_id
   AND s.is_active;

-- 3. Storage enforcement (mirrored in schema/src/banking.ts): refuse escape
-- shapes for every future writer. Tenant binding stays with the creation route
-- and the engine resolver (backendFor), which see the owning org and fail
-- closed for direct or stale rows. NOT VALID: quarantined legacy rows keep
-- their exact prior prefix as evidence; any UPDATE re-validates.
ALTER TABLE public.sftp_servers
  ADD CONSTRAINT sftp_servers_root_prefix_safe
  CHECK (
    root_prefix ~ '^[^/%]+(/[^/%]+)*$'
    AND root_prefix !~ '\\'
    AND root_prefix !~ '(^|/)\.\.?(/|$)'
  )
  NOT VALID;

COMMENT ON CONSTRAINT sftp_servers_root_prefix_safe ON public.sftp_servers IS
  'openbooks:root_prefix escape guard — a tenant names folders, never physical locations: relative, no backslash, no percent-encoding, no dot/empty segments. Tenant binding to sftp/<orgId>/ is enforced by the creation route and the engine storage resolver. NOT VALID: legacy non-conforming rows keep their exact prior prefix as quarantine evidence; any UPDATE re-validates, so a quarantined login stays deactivated until remediated.';

COMMENT ON COLUMN public.sftp_servers.root_prefix IS
  'Tenant-scoped root inside the app''s own storage, derived at creation as sftp/<orgId>/<server> — never a tenant-selected physical location. Escape shapes are refused by sftp_servers_root_prefix_safe; logins whose legacy prefix did not conform were deactivated by migration 0030 with the prior prefix preserved in audit_log evidence.';

-- 4. Fail-closed verification: after the quarantine, no ACTIVE login may
-- resolve outside its tenant namespace or carry an escape shape.
DO $sftp_root_prefix_containment_verification$
DECLARE
  offending_id uuid;
BEGIN
  SELECT s.id
    INTO offending_id
    FROM public.sftp_servers s
   WHERE s.is_active
     AND NOT public.sftp_root_prefix_tenant_conforms(s.org_id, s.root_prefix)
   ORDER BY s.id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'cannot finish sftp root-prefix tenant containment: active login % still resolves outside its tenant namespace',
      offending_id
      USING
        ERRCODE = '23514',
        HINT = 'Deactivate the offending sftp_servers row (or correct its root_prefix to the tenant namespace) and rerun the migration.';
  END IF;
END
$sftp_root_prefix_containment_verification$;
