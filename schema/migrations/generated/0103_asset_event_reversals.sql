BEGIN;

ALTER TABLE asset_events
  ADD COLUMN IF NOT EXISTS reverses_event_id uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

ALTER TABLE asset_events
  DROP CONSTRAINT IF EXISTS asset_events_reverses_event_fkey,
  ADD CONSTRAINT asset_events_reverses_event_fkey
    FOREIGN KEY (reverses_event_id) REFERENCES asset_events(id);

ALTER TABLE asset_events
  DROP CONSTRAINT IF EXISTS asset_events_reversal_shape,
  ADD CONSTRAINT asset_events_reversal_shape
  CHECK (
    (kind = 'reversed'
      AND reverses_event_id IS NOT NULL
      AND journal_entry_id IS NOT NULL
      AND reversal_reason IS NOT NULL
      AND length(btrim(reversal_reason)) BETWEEN 8 AND 500)
    OR
    (kind <> 'reversed'
      AND reverses_event_id IS NULL
      AND reversal_reason IS NULL)
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS asset_events_one_reversal
  ON asset_events (org_id, reverses_event_id)
  WHERE reverses_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION asset_event_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source record;
BEGIN
  IF tg_op IN ('UPDATE', 'DELETE') THEN
    IF openbooks_sandbox_wipe_allowed(old.org_id) THEN
      RETURN coalesce(new, old);
    END IF;
    RAISE EXCEPTION
      'asset lifecycle evidence is append-only; post a linked reversal event';
  END IF;

  IF new.kind = 'reversed' THEN
    SELECT id, org_id, asset_id, kind, journal_entry_id
      INTO source
      FROM asset_events
     WHERE id = new.reverses_event_id
     FOR KEY SHARE;
    IF source.id IS NULL
       OR source.org_id <> new.org_id
       OR source.asset_id <> new.asset_id
       OR source.kind NOT IN ('revalued', 'impaired', 'disposed', 'written_off')
       OR source.journal_entry_id IS NULL
    THEN
      RAISE EXCEPTION
        'an asset reversal must reference a reversible event for the same tenant and asset';
    END IF;
  END IF;
  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS asset_event_append_only_guard ON asset_events;
CREATE TRIGGER asset_event_append_only_guard
BEFORE INSERT OR UPDATE OR DELETE ON asset_events
FOR EACH ROW
EXECUTE FUNCTION asset_event_append_only_guard();

COMMIT;
