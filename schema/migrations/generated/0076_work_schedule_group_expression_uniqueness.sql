-- OpenBooks forward migration 0076_work_schedule_group_expression_uniqueness.
--
-- The work-schedule scope index was declared over five nullable scope columns.
-- PostgreSQL treats NULLs as distinct in an ordinary unique index, so every
-- organization-default row (and every scoped row with a different nullable
-- shape) could be duplicated for the same effective date. Resolution would
-- then choose an arbitrary contradictory schedule.
--
-- The canonical baseline already carries the intended expression index. This
-- forward migration brings databases that were installed from an older schema
-- to that same definition. Existing collisions are not guessed away: the
-- deterministic preflight reports the normalized key and every row id, then
-- aborts without deleting, deactivating, or rewriting tenant rows. An operator
-- can reconcile the identified configuration under an approved repair and
-- rerun the migration.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $work_schedule_scope_preflight$
DECLARE
  collision record;
BEGIN
  SELECT org_id,
         coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid) AS employee_scope,
         coalesce(lower(job_title), '') AS job_title_scope,
         coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid) AS trade_scope,
         coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid) AS department_scope,
         coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid) AS subsidiary_scope,
         effective_from,
         (array_agg(id ORDER BY id))::text[] AS row_ids
    INTO collision
    FROM public.work_schedules
   GROUP BY org_id,
            coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
            coalesce(lower(job_title), ''),
            coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid),
            coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
            coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
            effective_from
  HAVING count(*) > 1
   ORDER BY org_id, effective_from, employee_scope, job_title_scope,
            trade_scope, department_scope, subsidiary_scope
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'work_schedules uniqueness migration found a normalized scope collision',
      DETAIL = jsonb_build_object(
        'org_id', collision.org_id,
        'employee_scope', collision.employee_scope,
        'job_title_scope', collision.job_title_scope,
        'trade_scope', collision.trade_scope,
        'department_scope', collision.department_scope,
        'subsidiary_scope', collision.subsidiary_scope,
        'effective_from', collision.effective_from,
        'row_ids', collision.row_ids
      )::text,
      HINT = 'Reconcile the listed work-schedule rows under an approved tenant repair, then rerun migration 0076; this migration never drops or rewrites tenant rows.';
  END IF;
END
$work_schedule_scope_preflight$;

-- Replace the nullable-column index with the expression definition. Dropping
-- first also handles a prior interrupted/replayed rollout where the index name
-- exists with the old definition; the preflight above guarantees the CREATE is
-- safe and no row is lost during the replacement.
DROP INDEX IF EXISTS public.work_schedules_scope_from;

CREATE UNIQUE INDEX work_schedules_scope_from
  ON public.work_schedules USING btree (
    org_id,
    COALESCE(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(lower(job_title), ''::text),
    COALESCE(trade_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
    effective_from
  );

COMMENT ON INDEX public.work_schedules_scope_from IS
  'openbooks:work_schedule_scope_uniqueness:v1 - one schedule per organization, normalized scope, and effective_from; nullable scope keys use sentinels and job titles use lower-case normalization';
