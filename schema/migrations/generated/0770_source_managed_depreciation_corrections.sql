-- Preserve depreciation corrections as signed, journal-backed schedule evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE depreciation_schedule_lines
  ADD COLUMN reverses_line_id uuid REFERENCES depreciation_schedule_lines(id) DEFERRABLE,
  ADD COLUMN reversal_reason text;
CREATE UNIQUE INDEX depreciation_line_single_reversal ON depreciation_schedule_lines(reverses_line_id)
  WHERE reverses_line_id IS NOT NULL;
ALTER TABLE depreciation_schedule_lines DROP CONSTRAINT depr_lines_source_check,
  DROP CONSTRAINT depr_lines_amount_direction, DROP CONSTRAINT depr_lines_input_provenance;
ALTER TABLE depreciation_schedule_lines
  ADD CONSTRAINT depr_lines_source_check CHECK(source IN('formula','manual','production_usage','imported','reversal')),
  ADD CONSTRAINT depr_lines_amount_direction CHECK(source IN('manual','production_usage','reversal') OR (planned_amount>=0 AND (posted_amount IS NULL OR posted_amount>=0))),
  ADD CONSTRAINT depr_lines_input_provenance CHECK((source IN('formula','imported','reversal') AND input_id IS NULL) OR (source IN('manual','production_usage') AND input_id IS NOT NULL)),
  ADD CONSTRAINT depreciation_reversal_shape CHECK(
    (source='reversal' AND reverses_line_id IS NOT NULL AND reverses_line_id<>id AND reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) BETWEEN 8 AND 500
      AND posted_amount IS NOT NULL AND posted_amount=planned_amount AND journal_entry_id IS NOT NULL AND non_gl_recognized_at IS NULL)
    OR (source<>'reversal' AND reverses_line_id IS NULL AND reversal_reason IS NULL));

-- Input evidence applies to manual and production facts, not journal reversals.
DROP TRIGGER depreciation_line_input_guard ON depreciation_schedule_lines;
CREATE TRIGGER depreciation_line_input_guard BEFORE INSERT OR UPDATE OF schedule_id,period_id,source,input_id
  ON depreciation_schedule_lines FOR EACH ROW WHEN(NEW.source<>'reversal')
  EXECUTE FUNCTION openbooks_validate_depreciation_line_input();

CREATE FUNCTION depreciation_source_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE
  original depreciation_schedule_lines%ROWTYPE;
  asset fixed_assets%ROWTYPE;
  schedule depreciation_schedules%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' AND (OLD.journal_entry_id IS NOT NULL OR OLD.non_gl_recognized_at IS NOT NULL) THEN
    IF TG_OP='DELETE' AND openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Posted depreciation evidence is immutable; append a governed reversal.';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='INSERT' AND openbooks_clone_authority() THEN RETURN NEW; END IF;
  SELECT * INTO STRICT schedule FROM depreciation_schedules WHERE org_id=NEW.org_id AND id=NEW.schedule_id;
  SELECT * INTO STRICT asset FROM fixed_assets WHERE org_id=NEW.org_id AND id=schedule.asset_id FOR SHARE;
  IF asset.custom->'sourceManaged'='true'::jsonb AND NEW.source NOT IN('imported','reversal') THEN
    RAISE EXCEPTION 'Source-managed assets require source depreciation; synchronize the owning connection.';
  END IF;
  IF NEW.source<>'reversal' THEN RETURN NEW; END IF;
  SELECT * INTO STRICT original FROM depreciation_schedule_lines WHERE org_id=NEW.org_id AND id=NEW.reverses_line_id FOR UPDATE;
  IF original.source IN('imported','reversal') OR original.posted_amount IS NULL OR original.posted_amount=0
    OR original.journal_entry_id IS NULL OR original.non_gl_recognized_at IS NOT NULL
    OR original.schedule_id<>NEW.schedule_id OR original.period_id<>NEW.period_id
    OR NEW.posted_amount<>-original.posted_amount OR NEW.planned_amount<>-original.posted_amount
    OR asset.custom->'sourceManaged' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Depreciation correction must negate one local posting on its source-managed asset, book and period.';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM journal_entries source JOIN journal_entries reversal
      ON reversal.org_id=source.org_id AND reversal.reverses_entry_id=source.id
    WHERE source.org_id=NEW.org_id AND source.id=original.journal_entry_id AND source.status='reversed'
      AND source.origin='depreciation' AND source.book_id=schedule.book_id AND source.subsidiary_id=asset.subsidiary_id
      AND reversal.id=NEW.journal_entry_id AND reversal.status='posted' AND reversal.origin='depreciation'
      AND reversal.book_id=source.book_id AND reversal.period_id=source.period_id
      AND reversal.posting_date=source.posting_date AND reversal.subsidiary_id=source.subsidiary_id
  ) THEN RAISE EXCEPTION 'Depreciation correction requires its posted original-date journal reversal.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER depreciation_source_authority_guard BEFORE INSERT OR UPDATE OR DELETE
  ON depreciation_schedule_lines FOR EACH ROW EXECUTE FUNCTION depreciation_source_authority_guard();
SELECT openbooks_refresh_query_catalog();
