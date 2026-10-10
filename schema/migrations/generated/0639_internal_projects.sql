-- Native internal (shop/overhead) projects: a non-billable time target per
-- legal entity for shop days, so they no longer book to customer jobs and
-- misstate job cost. An internal project has no customer and carries no
-- invoicing configuration, and its flag locks once time is booked to it.
-- Overhead stays statistical: internal time posts no labor cost (the WIP
-- writer skips internal projects) and bills nothing (billing needs a
-- customer), so internal time alone moves no company ledger.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Backfill-safe: every existing project is customer work, so false is correct
-- for all of them and no row violates the check below.
ALTER TABLE projects ADD COLUMN is_internal boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD CONSTRAINT projects_internal_no_customer_billing CHECK (
  NOT is_internal OR (customer_id IS NULL AND invoicing_profile IS NULL AND invoicing_preference IS NULL)
);

-- The flag is immutable once time is booked to the project: flipping it
-- under booked hours would silently move job cost into overhead or expose
-- overhead hours to customer billing. Change scope by creating a new
-- project instead.
CREATE OR REPLACE FUNCTION projects_internal_flag_locked() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_internal IS DISTINCT FROM NEW.is_internal AND EXISTS (
    SELECT 1 FROM time_entries WHERE org_id = NEW.org_id AND project_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'project % has booked time and its internal flag is immutable', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_internal_flag_immutable
  BEFORE UPDATE OF is_internal ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_internal_flag_locked();
