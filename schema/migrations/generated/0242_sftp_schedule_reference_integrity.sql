-- OpenBooks forward migration 0242_sftp_schedule_reference_integrity.
--
-- A schedule creation POST only checked UUID shapes before inserting, while
-- the schedule list and the import scan join both parents by (org_id, id):
--
--   GET sftp_import_schedules sc
--     join sftp_servers sv on sv.id = sc.sftp_server_id and sv.org_id = sc.org_id
--     join accounts a on a.id = sc.account_id and a.org_id = sc.org_id
--   runDueSftpImports ... join sftp_servers sv on sv.id = sc.sftp_server_id
--     and sv.org_id = sc.org_id and sv.is_active
--
-- The schema declared NO parent foreign keys for sftp_import_schedules
-- (migration 0044 only upgrades existing FK edges, so a table with none
-- stayed unguarded). A valid-shaped unknown or foreign-organization server
-- or account id therefore saved with 200 yet never appeared in GET and
-- could never run: an invisible orphan holding a cross-tenant reference.
--
-- This migration makes that unrepresentable rather than merely
-- discouraged, in the established 0195/0241 composite form:
--
--   FOREIGN KEY (org_id, sftp_server_id) REFERENCES sftp_servers(org_id, id)
--   FOREIGN KEY (org_id, account_id) REFERENCES accounts(org_id, id)
--
-- DEFERRABLE matches 0195/0241 and matters for seed paths that write a
-- child before its parent settles inside one transaction. There is no
-- ON DELETE action (NO ACTION): deleting a server that still feeds
-- schedules keeps refusing at the storage layer with 23503, which the
-- server DELETE route already maps to the same typed 409 its
-- dependent-count check returns — an unreferenced server still deletes
-- normally. Organization cleanup is unaffected: teardown deletes children
-- before parents across converging passes, so removing the schedules
-- first keeps every pass green.
--
-- No data is rewritten, deleted, or silently repaired: any legacy row
-- naming a missing parent or a parent in another organization aborts the
-- migration before DDL changes begin, naming the row and the remedy.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $sftp_schedule_reference_preflight$
DECLARE
  violation record;
BEGIN
  -- A schedule whose server is missing or lives in another organization
  -- would vanish from the joined schedule list the moment it is saved.
  SELECT sc.id::text AS schedule_id,
         sc.ctid::text AS row_ctid,
         sc.org_id::text AS org_id,
         sc.sftp_server_id::text AS server_id,
         sv.org_id::text AS server_org_id
    INTO violation
    FROM public.sftp_import_schedules sc
    LEFT JOIN public.sftp_servers sv ON sv.id = sc.sftp_server_id
   WHERE sv.id IS NULL OR sv.org_id IS DISTINCT FROM sc.org_id
   ORDER BY sc.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.sftp_import_schedules.sftp_server_id',
      DETAIL = jsonb_build_object(
        'table', 'sftp_import_schedules',
        'schedule_id', violation.schedule_id,
        'row', violation.row_ctid,
        'org_id', violation.org_id,
        'column', 'sftp_server_id',
        'reference_id', violation.server_id,
        'referenced_table', 'sftp_servers',
        'referenced_org_id', violation.server_org_id
      )::text,
      HINT = 'Point the schedule at an SFTP server owned by the same organization, or delete the orphaned schedule, then retry migration 0242. This migration will not rewrite schedule references.';
  END IF;

  -- Same shape for the statement account: a foreign or missing account
  -- never resolves in the joined list and can never back an import.
  SELECT sc.id::text AS schedule_id,
         sc.ctid::text AS row_ctid,
         sc.org_id::text AS org_id,
         sc.account_id::text AS account_id,
         a.org_id::text AS account_org_id
    INTO violation
    FROM public.sftp_import_schedules sc
    LEFT JOIN public.accounts a ON a.id = sc.account_id
   WHERE a.id IS NULL OR a.org_id IS DISTINCT FROM sc.org_id
   ORDER BY sc.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.sftp_import_schedules.account_id',
      DETAIL = jsonb_build_object(
        'table', 'sftp_import_schedules',
        'schedule_id', violation.schedule_id,
        'row', violation.row_ctid,
        'org_id', violation.org_id,
        'column', 'account_id',
        'reference_id', violation.account_id,
        'referenced_table', 'accounts',
        'referenced_org_id', violation.account_org_id
      )::text,
      HINT = 'Point the schedule at a bank account owned by the same organization, or delete the orphaned schedule, then retry migration 0242. This migration will not rewrite schedule references.';
  END IF;
END
$sftp_schedule_reference_preflight$;

-- PostgreSQL requires an exact unique key for each composite FK target.
-- accounts already carries accounts_org_id_id_unique (0037/0038/0039/0044);
-- sftp_servers has never been a composite target, so its key is new.
CREATE UNIQUE INDEX IF NOT EXISTS sftp_servers_org_id_id_unique
  ON public.sftp_servers USING btree (org_id, id);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sftp_import_schedules_sftp_server_id_tenant_fkey') THEN
  ALTER TABLE ONLY public.sftp_import_schedules ADD CONSTRAINT sftp_import_schedules_sftp_server_id_tenant_fkey
    FOREIGN KEY (org_id, sftp_server_id) REFERENCES public.sftp_servers(org_id, id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sftp_import_schedules_account_id_tenant_fkey') THEN
  ALTER TABLE ONLY public.sftp_import_schedules ADD CONSTRAINT sftp_import_schedules_account_id_tenant_fkey
    FOREIGN KEY (org_id, account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE; END IF; END $$;
