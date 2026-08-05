-- Enforce the operational invariant used by both manual and scheduled backup
-- creation: an organization may have at most one queued/running backup.
--
-- Older releases used a check-then-insert guard. Reconcile any rows created by
-- that race before adding the constraint, preferring an already-running export
-- over a queued one and otherwise retaining the oldest run.
with ranked as (
  select id,
         row_number() over (
           partition by org_id
           order by case status when 'running' then 0 else 1 end,
                    created_at,
                    id
         ) as position
    from public.backup_runs
   where status in ('queued', 'running')
)
update public.backup_runs as run
   set status = 'failed',
       error = coalesce(run.error, 'superseded while enforcing one in-flight backup per organization'),
       completed_at = coalesce(run.completed_at, now()),
       updated_at = now()
  from ranked
 where run.id = ranked.id
   and ranked.position > 1;

create unique index backup_runs_one_inflight_per_org
  on public.backup_runs(org_id)
  where status in ('queued', 'running');
