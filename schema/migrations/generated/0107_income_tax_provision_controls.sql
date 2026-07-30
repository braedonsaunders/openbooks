-- Preserve income-tax workpapers and enforce an exactly-one-live lifecycle.

ALTER TABLE tax_provision_runs
  DROP CONSTRAINT IF EXISTS tax_provision_runs_status_chk,
  ADD CONSTRAINT tax_provision_runs_status_chk
    CHECK (status IN ('draft', 'discarded', 'posted', 'superseded'));

CREATE UNIQUE INDEX IF NOT EXISTS tax_provision_runs_one_draft_per_fy
  ON tax_provision_runs (org_id, fiscal_year)
  WHERE status = 'draft';

CREATE UNIQUE INDEX IF NOT EXISTS tax_provision_runs_one_posted_per_fy
  ON tax_provision_runs (org_id, fiscal_year)
  WHERE status = 'posted';

CREATE UNIQUE INDEX IF NOT EXISTS tax_provision_runs_journal_lineage
  ON tax_provision_runs (org_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

ALTER TABLE tax_provision_runs
  DROP CONSTRAINT IF EXISTS tax_provision_runs_lifecycle_shape_chk,
  ADD CONSTRAINT tax_provision_runs_lifecycle_shape_chk CHECK (
    (
      status IN ('draft', 'discarded')
      AND journal_entry_id IS NULL
      AND posted_at IS NULL
      AND posted_by IS NULL
    )
    OR
    (
      status IN ('posted', 'superseded')
      AND journal_entry_id IS NOT NULL
      AND posted_at IS NOT NULL
      AND posted_by IS NOT NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION protect_tax_provision_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'finalized income-tax provision runs are append-only (run %, status %)',
        OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('discarded', 'superseded') THEN
    RAISE EXCEPTION
      'finalized income-tax provision runs are immutable (run %, status %)',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'posted' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION
      'posted income-tax provision runs may only transition to superseded (run %)',
      OLD.id;
  END IF;

  IF OLD.status = 'posted' AND (
    NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
    OR NEW.period_from IS DISTINCT FROM OLD.period_from
    OR NEW.period_to IS DISTINCT FROM OLD.period_to
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
    OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
    OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  ) THEN
    RAISE EXCEPTION
      'posted income-tax provision evidence is immutable (run %)',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tax_provision_history_guard ON tax_provision_runs;
CREATE TRIGGER tax_provision_history_guard
BEFORE UPDATE OR DELETE ON tax_provision_runs
FOR EACH ROW EXECUTE FUNCTION protect_tax_provision_history();

CREATE OR REPLACE FUNCTION protect_temporary_difference_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_run_id uuid;
  target_status text;
BEGIN
  target_run_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  SELECT status
    INTO target_status
    FROM tax_provision_runs
   WHERE id = target_run_id
     AND org_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'temporary difference must reference a tenant-owned provision run';
  END IF;
  IF target_status <> 'draft' THEN
    RAISE EXCEPTION
      'temporary differences are immutable after provision finalization (run %, status %)',
      target_run_id, target_status;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS temporary_difference_history_guard
  ON temporary_differences;
CREATE TRIGGER temporary_difference_history_guard
BEFORE INSERT OR UPDATE OR DELETE ON temporary_differences
FOR EACH ROW EXECUTE FUNCTION protect_temporary_difference_history();
