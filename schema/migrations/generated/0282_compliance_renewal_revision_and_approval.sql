-- OpenBooks forward migration 0282_compliance_renewal_revision_and_approval.
--
-- A PENDING renewal immediately superseded the still-valid certificate it
-- named, so the vendor read as uncovered until the renewal was verified; a
-- renewal link that matched nothing was silently ignored while the POST still
-- reported success; certificate PATCH rewrote the row from a
-- pre-transaction read with no concurrency fence; and one compliance.waive
-- holder both requested and approved an exception. compliance_records gains
-- the pending renewal link the verifier resolves (supersedes_id, followed
-- only when the renewal is verified), the optimistic revision PATCH fences
-- on, and the revision the verification attested (verified_revision);
-- compliance_waivers gains the requester the approver must differ from
-- (requested_by) and a nullable approval instant so a requested-but-unproved
-- exception is pending rather than approved. Existing rows start at
-- revision 1 with no pending links; existing waivers keep their approval and
-- record their creator as requester. Re-runnable: every statement is guarded
-- by IF NOT EXISTS.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE ONLY public.compliance_records
  ADD COLUMN IF NOT EXISTS supersedes_id uuid;
ALTER TABLE ONLY public.compliance_records
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE ONLY public.compliance_records
  ADD COLUMN IF NOT EXISTS verified_revision integer;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_records_supersedes_fk') THEN
  ALTER TABLE ONLY public.compliance_records ADD CONSTRAINT compliance_records_supersedes_fk
    FOREIGN KEY (supersedes_id) REFERENCES public.compliance_records(id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_records_revision') THEN
  ALTER TABLE ONLY public.compliance_records ADD CONSTRAINT compliance_records_revision
    CHECK (revision >= 1); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_records_verified_revision') THEN
  ALTER TABLE ONLY public.compliance_records ADD CONSTRAINT compliance_records_verified_revision
    CHECK (verified_revision IS NULL OR verified_revision >= 1); END IF; END $$;

CREATE INDEX IF NOT EXISTS compliance_records_supersedes
  ON public.compliance_records USING btree (org_id, supersedes_id);

ALTER TABLE ONLY public.compliance_waivers
  ADD COLUMN IF NOT EXISTS requested_by uuid;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_waivers_requested_by_fk') THEN
  ALTER TABLE ONLY public.compliance_waivers ADD CONSTRAINT compliance_waivers_requested_by_fk
    FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;

-- Requested-but-unapproved exceptions are pending, not approved: backfill
-- the requester from the creator, then allow a null approval instant.
UPDATE public.compliance_waivers SET requested_by = created_by WHERE requested_by IS NULL;

ALTER TABLE ONLY public.compliance_waivers ALTER COLUMN approved_at DROP NOT NULL;
