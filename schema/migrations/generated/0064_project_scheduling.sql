-- Project scheduling: critical-path planning over the existing work breakdown.
--
-- The scheduled activity IS project_tasks, so the plan columns are added there
-- rather than in a parallel task table. Everything here is planning data: it
-- never posts, and every column is nullable or defaulted so existing rows and
-- orgs without the Project Scheduling feature are untouched.
--
-- Row-level security is installed generically for any table carrying org_id
-- (see schema/migrations/environments.sql) — re-run it after this migration.

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS schedule_task_type text NOT NULL DEFAULT 'task',
  ADD COLUMN IF NOT EXISTS schedule_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS schedule_start date,
  ADD COLUMN IF NOT EXISTS schedule_end date,
  ADD COLUMN IF NOT EXISTS schedule_duration integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS schedule_progress numeric(5,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS schedule_assignee text,
  ADD COLUMN IF NOT EXISTS schedule_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS schedule_outline_level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS schedule_calendar_id uuid,
  ADD COLUMN IF NOT EXISTS schedule_phase text,
  ADD COLUMN IF NOT EXISTS schedule_constraint_type text NOT NULL DEFAULT 'asap',
  ADD COLUMN IF NOT EXISTS schedule_constraint_date date,
  ADD COLUMN IF NOT EXISTS schedule_deadline_date date,
  ADD COLUMN IF NOT EXISTS schedule_actual_start date,
  ADD COLUMN IF NOT EXISTS schedule_actual_end date;

DO $$ BEGIN
  ALTER TABLE project_tasks
    ADD CONSTRAINT project_tasks_schedule_task_type_chk
    CHECK (schedule_task_type IN ('task', 'milestone', 'summary'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE project_tasks
    ADD CONSTRAINT project_tasks_schedule_status_chk
    CHECK (schedule_status IN ('not_started', 'in_progress', 'complete', 'on_hold'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE project_tasks
    ADD CONSTRAINT project_tasks_schedule_constraint_type_chk
    CHECK (schedule_constraint_type IN
      ('asap', 'alap', 'snet', 'snlt', 'fnet', 'fnlt', 'mso', 'mfo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Progress is a fraction, not a percentage. Enforced so a 100 can never be
-- stored and later read back as 10,000%.
DO $$ BEGIN
  ALTER TABLE project_tasks
    ADD CONSTRAINT project_tasks_schedule_progress_chk
    CHECK (schedule_progress >= 0 AND schedule_progress <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A finish before its start is not a schedule, it is a data-entry accident.
DO $$ BEGIN
  ALTER TABLE project_tasks
    ADD CONSTRAINT project_tasks_schedule_dates_chk
    CHECK (schedule_start IS NULL OR schedule_end IS NULL OR schedule_end >= schedule_start);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS project_tasks_schedule_order
  ON project_tasks (org_id, project_id, schedule_order);

-- Existing WBS rows get a deterministic display order so an org that switches
-- scheduling on sees its tasks in a stable sequence instead of arbitrary order.
UPDATE project_tasks t
   SET schedule_order = ordered.rn
  FROM (
    SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY code NULLS LAST, name, id) AS rn
      FROM project_tasks
  ) ordered
 WHERE ordered.id = t.id
   AND t.schedule_order = 0;

CREATE TABLE IF NOT EXISTS schedule_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid,
  name text NOT NULL,
  description text,
  is_default boolean NOT NULL DEFAULT false,
  working_days jsonb NOT NULL DEFAULT
    '{"0":false,"1":true,"2":true,"3":true,"4":true,"5":true,"6":false}'::jsonb,
  holidays jsonb NOT NULL DEFAULT '[]'::jsonb,
  shift_start_minutes integer NOT NULL DEFAULT 480,
  shift_end_minutes integer NOT NULL DEFAULT 1020,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE INDEX IF NOT EXISTS schedule_calendars_org ON schedule_calendars (org_id, project_id);

CREATE TABLE IF NOT EXISTS schedule_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid,
  calendar_id uuid,
  name text NOT NULL,
  role text,
  kind text NOT NULL DEFAULT 'crew',
  color text,
  party_id uuid,
  equipment_id uuid,
  default_units numeric(9,4) NOT NULL DEFAULT 1,
  capacity_per_day numeric(9,4) NOT NULL DEFAULT 1,
  cost_rate numeric(19,4),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT schedule_resources_kind_chk
    CHECK (kind IN ('labor', 'crew', 'equipment', 'subcontractor')),
  -- Zero capacity would make every assignment permanently unlevellable.
  CONSTRAINT schedule_resources_capacity_chk CHECK (capacity_per_day > 0)
);
CREATE INDEX IF NOT EXISTS schedule_resources_org ON schedule_resources (org_id, project_id);

CREATE TABLE IF NOT EXISTS schedule_task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  task_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  units numeric(9,4) NOT NULL DEFAULT 1,
  role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT schedule_task_assignments_units_chk CHECK (units > 0)
);
CREATE INDEX IF NOT EXISTS schedule_task_assignments_task
  ON schedule_task_assignments (org_id, task_id);
CREATE INDEX IF NOT EXISTS schedule_task_assignments_resource
  ON schedule_task_assignments (org_id, resource_id);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_task_assignments_unique
  ON schedule_task_assignments (task_id, resource_id);

CREATE TABLE IF NOT EXISTS schedule_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  predecessor_id uuid NOT NULL,
  successor_id uuid NOT NULL,
  type text NOT NULL DEFAULT 'FS',
  lag_days integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT schedule_dependencies_type_chk CHECK (type IN ('FS', 'SS', 'FF', 'SF')),
  -- A task cannot depend on itself; longer cycles are rejected in the service.
  CONSTRAINT schedule_dependencies_self_chk CHECK (predecessor_id <> successor_id)
);
CREATE INDEX IF NOT EXISTS schedule_dependencies_project
  ON schedule_dependencies (org_id, project_id);
CREATE INDEX IF NOT EXISTS schedule_dependencies_predecessor
  ON schedule_dependencies (predecessor_id);
CREATE INDEX IF NOT EXISTS schedule_dependencies_successor
  ON schedule_dependencies (successor_id);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_dependencies_unique
  ON schedule_dependencies (predecessor_id, successor_id);

CREATE TABLE IF NOT EXISTS schedule_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'snapshot',
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT schedule_baselines_kind_chk
    CHECK (kind IN ('primary', 'secondary', 'tertiary', 'snapshot', 'custom'))
);
CREATE INDEX IF NOT EXISTS schedule_baselines_project ON schedule_baselines (org_id, project_id);
-- At most one primary baseline per project: "the" baseline has to be singular
-- for variance to mean anything.
CREATE UNIQUE INDEX IF NOT EXISTS schedule_baselines_one_primary
  ON schedule_baselines (project_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS schedule_baseline_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  baseline_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_name text NOT NULL,
  start_date date,
  end_date date,
  duration integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE INDEX IF NOT EXISTS schedule_baseline_tasks_baseline
  ON schedule_baseline_tasks (org_id, baseline_id);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_baseline_tasks_unique
  ON schedule_baseline_tasks (baseline_id, task_id);

-- ---------------------------------------------------------------------------
-- Tenant isolation + read role (standard pattern, matches 0041 et al.)
-- ---------------------------------------------------------------------------

do $$
declare
  tbl text;
  body text := $pol$
    (
      current_setting('app.bypass_rls', true) = 'on'
      or org_id::text = current_setting('app.current_org', true)
    )
  $pol$;
begin
  foreach tbl in array array[
    'schedule_calendars',
    'schedule_resources',
    'schedule_task_assignments',
    'schedule_dependencies',
    'schedule_baselines',
    'schedule_baseline_tasks'
  ]
  loop
    execute format('grant select on %I to openbooks_read', tbl);
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    execute format('drop policy if exists org_isolation on %I', tbl);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', tbl, body, body);
  end loop;
end $$;
