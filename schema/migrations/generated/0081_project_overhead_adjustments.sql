BEGIN;

CREATE TABLE IF NOT EXISTS project_overhead_adjustments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  adjustment_date date NOT NULL,
  amount numeric(19,4) NOT NULL,
  reason text NOT NULL,
  source_system text,
  source_ref text,
  reverses_adjustment_id uuid
    REFERENCES project_overhead_adjustments(id),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT project_overhead_adjustments_nonzero
    CHECK (amount <> 0),
  CONSTRAINT project_overhead_adjustments_reason
    CHECK (length(btrim(reason)) >= 8),
  CONSTRAINT project_overhead_adjustments_not_self_reversing
    CHECK (
      reverses_adjustment_id IS NULL
      OR reverses_adjustment_id <> id
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  project_overhead_adjustments_source_identity
  ON project_overhead_adjustments (org_id, source_system, source_ref)
  WHERE source_system IS NOT NULL AND source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_overhead_adjustments_project_date
  ON project_overhead_adjustments (org_id, project_id, adjustment_date);

CREATE OR REPLACE FUNCTION project_overhead_adjustment_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF tg_op = 'DELETE'
     AND openbooks_sandbox_wipe_allowed(old.org_id)
  THEN
    RETURN old;
  END IF;
  IF tg_op IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'project overhead adjustments are append-only; post a reversing adjustment';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM projects p
     WHERE p.id = new.project_id
       AND p.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION
      'project overhead adjustment must belong to the project organization';
  END IF;
  IF new.reverses_adjustment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM project_overhead_adjustments original
     WHERE original.id = new.reverses_adjustment_id
       AND original.org_id = new.org_id
       AND original.project_id = new.project_id
       AND original.amount = -new.amount
  ) THEN
    RAISE EXCEPTION
      'a reversing overhead adjustment must exactly offset the same project';
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS project_overhead_adjustment_guard
  ON project_overhead_adjustments;
CREATE TRIGGER project_overhead_adjustment_guard
BEFORE INSERT OR UPDATE OR DELETE
ON project_overhead_adjustments
FOR EACH ROW EXECUTE FUNCTION project_overhead_adjustment_guard();

ALTER TABLE project_overhead_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_overhead_adjustments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON project_overhead_adjustments;
CREATE POLICY org_isolation ON project_overhead_adjustments
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  );

COMMIT;
