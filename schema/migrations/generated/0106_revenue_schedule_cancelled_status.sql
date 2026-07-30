-- Revenue-recognition cancellation preserves the plan and marks it cancelled.
alter table recognition_schedules
  drop constraint if exists rec_schedules_status_check;
alter table recognition_schedules
  add constraint rec_schedules_status_check
  check (status in ('planned', 'in_progress', 'complete', 'cancelled'));
