-- OpenBooks forward migration 0353_hrm_leave_attachment_tenant_fk.
-- Ensure leave evidence names a file owned by the same organization.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_leave_requests_attachment_tenant_fkey'
       AND conrelid = 'public.hrm_leave_requests'::regclass
  ) THEN
    ALTER TABLE public.hrm_leave_requests
      ADD CONSTRAINT hrm_leave_requests_attachment_tenant_fkey
      FOREIGN KEY (org_id, attachment_id)
      REFERENCES public.files (org_id, id)
      ON DELETE RESTRICT DEFERRABLE;
  END IF;
END $$;
