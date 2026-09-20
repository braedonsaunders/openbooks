-- OpenBooks forward migration 0198_hrm_self_service_profile.
--
-- HR-9 employee and manager self-service: the person's own contact profile.
--
-- A person may propose changes to their OWN contact fields (phone, personal
-- email, postal address, emergency contact) as a profile_change request
-- through the existing hrm_employment_change_requests lifecycle (0185);
-- the request kind vocabulary lives in the payload jsonb the service
-- validates, so no storage change is needed for the kind itself. WHAT NEEDS
-- STORAGE:
--
--   parties.emergency_contact jsonb — phone and personal email already live
--   on parties, the postal address lives in addresses (party_id), but the
--   emergency contact has no column anywhere. Nullable: most parties are
--   not people, and a person with no emergency contact on file is
--   legitimate — null means none recorded, never a refusal. Shape-pinned by
--   the CHECK below (an object with optional non-blank name, relationship,
--   and phone strings); the service validates the same shape before
--   writing, so a CHECK violation names a service bug, not a user error.
--   Masked in sandboxes (null_out, like tax_ids): it is candidate PII.
--
--   employment_changes.change_kind gains 'profile_changed' — the
--   all-or-nothing application of an approved profile_change writes its
--   evidence as an appended employment_changes event (actor, timestamp,
--   before/after party state, reason) on the bound employment, exactly
--   like every other kind. The CHECK is dropped and re-created with the
--   one added member; every existing member is preserved verbatim.
--
-- Additive only. No backfill (existing rows read null = none recorded),
-- no RLS change (parties and employment_changes keep their policies), no
-- new table (the brief forbids a parallel request table), no GENERATED
-- column (the column-enumeration registry is untouched).

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- (1) Emergency contact on the person row.
ALTER TABLE public.parties
  ADD COLUMN IF NOT EXISTS emergency_contact jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'parties_emergency_contact_shape'
  ) THEN
    ALTER TABLE public.parties
      ADD CONSTRAINT parties_emergency_contact_shape CHECK (
        emergency_contact IS NULL
        OR (
          jsonb_typeof(emergency_contact) = 'object'
          AND (
            NOT (emergency_contact ? 'name')
            OR (
              jsonb_typeof(emergency_contact -> 'name') = 'string'
              AND char_length(btrim(emergency_contact ->> 'name')) > 0
            )
          )
          AND (
            NOT (emergency_contact ? 'relationship')
            OR (
              jsonb_typeof(emergency_contact -> 'relationship') = 'string'
              AND char_length(btrim(emergency_contact ->> 'relationship')) > 0
            )
          )
          AND (
            NOT (emergency_contact ? 'phone')
            OR (
              jsonb_typeof(emergency_contact -> 'phone') = 'string'
              AND char_length(btrim(emergency_contact ->> 'phone')) > 0
            )
          )
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.parties.emergency_contact IS
  'HR-9 self-service (0198): the person''s emergency contact as {name, relationship, phone}; null = none recorded. Proposed by the person through a profile_change request, applied on HR approval; masked (null_out) in sandboxes.';

-- (2) The profile application evidence kind on the immutable event ledger.
ALTER TABLE public.employment_changes
  DROP CONSTRAINT IF EXISTS employment_changes_kind;

ALTER TABLE public.employment_changes
  ADD CONSTRAINT employment_changes_kind CHECK (change_kind IN
    ('created', 'status_changed', 'assignment_issued',
     'assignment_superseded', 'corrected', 'terminated',
     'rehired_reference', 'profile_changed'));
