-- OpenBooks forward migration 0278_equipment_unit_revision.
--
-- Equipment PATCH read the unit row outside its transaction and rewrote every
-- financial and lifecycle column, so two concurrent edits silently lost one
-- writer's changes and the audit logged a stale before-image. The unit gains
-- a revision counter: PATCH compares the caller's revision against the row
-- locked FOR UPDATE inside the write transaction and bumps it on every
-- applied change, so a stale writer is refused instead of overwriting the
-- winner. Existing rows start at zero; the counter only moves through PATCH
-- (and capitalization, which also mutates the row).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
