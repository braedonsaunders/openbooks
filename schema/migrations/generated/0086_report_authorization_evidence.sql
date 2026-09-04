-- OpenBooks forward migration 0086_report_authorization_evidence
-- Additive rollout: preserve all historical bytes. Legacy runs deliberately
-- retain NULL scope and are denied at download; existing schedules require an
-- authorized edit before execution. Never infer old scope from a mutable plan.
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS authorization_snapshot jsonb;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS authorization_snapshot jsonb;

CREATE OR REPLACE FUNCTION protect_report_run_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authorization_snapshot IS DISTINCT FROM OLD.authorization_snapshot THEN
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS report_run_authorization_immutable ON report_runs;
CREATE TRIGGER report_run_authorization_immutable
BEFORE UPDATE ON report_runs FOR EACH ROW
EXECUTE FUNCTION protect_report_run_authorization();
