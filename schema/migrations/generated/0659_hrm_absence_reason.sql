-- OpenBooks forward migration 0659_hrm_absence_reason.
--
-- Manager-recorded absences carry the basis for the filing (for example a
-- verbal approval of a back-dated day). hrm_leave_requests already stores a
-- reason; hrm_absences never had one, so a recording wrote no basis. The
-- column stays nullable so history recorded before this change keeps its
-- shape, and the named check admits NULL while refusing a blank string, so
-- a blank can never satisfy the basis requirement the engine enforces.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_absences ADD COLUMN IF NOT EXISTS reason text;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_absences_reason_nonblank') THEN
  ALTER TABLE ONLY public.hrm_absences ADD CONSTRAINT hrm_absences_reason_nonblank
    CHECK (reason IS NULL OR btrim(reason) <> ''); END IF; END $$;
