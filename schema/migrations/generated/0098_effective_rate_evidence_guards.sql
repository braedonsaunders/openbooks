BEGIN;

-- Active/retired price-list versions are historical commercial evidence.
-- Their children may only be authored while the version is a draft.
CREATE OR REPLACE FUNCTION rate_version_child_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_org_id uuid;
BEGIN
  SELECT status, org_id
    INTO v_status, v_org_id
    FROM item_rate_versions
   WHERE id = coalesce(NEW.version_id, OLD.version_id);
  IF v_status IS NULL
     OR v_org_id IS DISTINCT FROM coalesce(NEW.org_id, OLD.org_id) THEN
    RAISE EXCEPTION 'rate-version child must reference a tenant-owned version'
      USING ERRCODE = '23514';
  END IF;
  IF v_status <> 'draft' THEN
    IF TG_OP = 'DELETE'
       AND openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'children of an activated or retired rate version are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE OR REPLACE FUNCTION rate_adjustment_target_version_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_org_id uuid;
BEGIN
  SELECT version.status, adjustment.org_id
    INTO v_status, v_org_id
    FROM labor_rate_adjustments adjustment
    JOIN item_rate_versions version
      ON version.id = adjustment.version_id
     AND version.org_id = adjustment.org_id
   WHERE adjustment.id = coalesce(NEW.adjustment_id, OLD.adjustment_id);
  IF v_status IS NULL
     OR v_org_id IS DISTINCT FROM coalesce(NEW.org_id, OLD.org_id) THEN
    RAISE EXCEPTION 'adjustment target must reference a tenant-owned rate version'
      USING ERRCODE = '23514';
  END IF;
  IF v_status <> 'draft' THEN
    IF TG_OP = 'DELETE'
       AND openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'targets of an activated or retired rate version are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE OR REPLACE FUNCTION rate_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft'
       OR openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'activated and retired rate versions cannot be deleted';
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;

  IF OLD.status = 'active' AND NEW.status = 'active'
     AND NEW.org_id = OLD.org_id
     AND NEW.rate_book_id = OLD.rate_book_id
     AND NEW.effective_from = OLD.effective_from
     AND NEW.custom IS NOT DISTINCT FROM OLD.custom
     AND NEW.effective_to IS NOT NULL
     AND NEW.effective_to >= OLD.effective_from
     AND (OLD.effective_to IS NULL OR NEW.effective_to <= OLD.effective_to) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired'
     AND NEW.org_id = OLD.org_id
     AND NEW.rate_book_id = OLD.rate_book_id
     AND NEW.effective_from = OLD.effective_from
     AND NEW.effective_to IS NOT DISTINCT FROM OLD.effective_to
     AND NEW.custom IS NOT DISTINCT FROM OLD.custom THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'activated and retired rate versions are immutable';
END
$$;

CREATE OR REPLACE FUNCTION rate_book_currency_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    IF EXISTS (
      SELECT 1 FROM item_rate_versions version
       WHERE version.rate_book_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'a rate book with version history cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'rate book organization is immutable';
  END IF;
  IF NEW.currency IS DISTINCT FROM OLD.currency
     AND EXISTS (
       SELECT 1 FROM item_rate_versions version
        WHERE version.rate_book_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'rate book currency cannot change after version history exists';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS item_rate_lines_version_guard ON item_rate_lines;
CREATE TRIGGER item_rate_lines_version_guard
BEFORE INSERT OR UPDATE OR DELETE ON item_rate_lines
FOR EACH ROW EXECUTE FUNCTION rate_version_child_guard();

DROP TRIGGER IF EXISTS labor_rate_version_policies_version_guard
  ON labor_rate_version_policies;
CREATE TRIGGER labor_rate_version_policies_version_guard
BEFORE INSERT OR UPDATE OR DELETE ON labor_rate_version_policies
FOR EACH ROW EXECUTE FUNCTION rate_version_child_guard();

DROP TRIGGER IF EXISTS labor_rate_version_scopes_version_guard
  ON labor_rate_version_scopes;
CREATE TRIGGER labor_rate_version_scopes_version_guard
BEFORE INSERT OR UPDATE OR DELETE ON labor_rate_version_scopes
FOR EACH ROW EXECUTE FUNCTION rate_version_child_guard();

DROP TRIGGER IF EXISTS labor_rate_adjustments_version_guard
  ON labor_rate_adjustments;
CREATE TRIGGER labor_rate_adjustments_version_guard
BEFORE INSERT OR UPDATE OR DELETE ON labor_rate_adjustments
FOR EACH ROW EXECUTE FUNCTION rate_version_child_guard();

DROP TRIGGER IF EXISTS labor_rate_terms_version_guard ON labor_rate_terms;
CREATE TRIGGER labor_rate_terms_version_guard
BEFORE INSERT OR UPDATE OR DELETE ON labor_rate_terms
FOR EACH ROW EXECUTE FUNCTION rate_version_child_guard();

DROP TRIGGER IF EXISTS labor_rate_adjustment_targets_version_guard
  ON labor_rate_adjustment_targets;
CREATE TRIGGER labor_rate_adjustment_targets_version_guard
BEFORE INSERT OR UPDATE OR DELETE ON labor_rate_adjustment_targets
FOR EACH ROW EXECUTE FUNCTION rate_adjustment_target_version_guard();

DROP TRIGGER IF EXISTS item_rate_versions_immutable ON item_rate_versions;
CREATE TRIGGER item_rate_versions_immutable
BEFORE UPDATE OR DELETE ON item_rate_versions
FOR EACH ROW EXECUTE FUNCTION rate_version_immutable();

DROP TRIGGER IF EXISTS item_rate_books_currency_guard ON item_rate_books;
CREATE TRIGGER item_rate_books_currency_guard
BEFORE UPDATE OR DELETE ON item_rate_books
FOR EACH ROW EXECUTE FUNCTION rate_book_currency_guard();

CREATE INDEX IF NOT EXISTS obligations_document_line
  ON performance_obligations (document_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'time_types'::regclass
       AND conname = 'time_types_bill_multiplier_check'
  ) THEN
    ALTER TABLE time_types
      ADD CONSTRAINT time_types_bill_multiplier_check
      CHECK (bill_multiplier >= 0)
      NOT VALID;
  END IF;
END
$$;
ALTER TABLE time_types VALIDATE CONSTRAINT time_types_bill_multiplier_check;

COMMIT;
