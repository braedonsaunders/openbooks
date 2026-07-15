-- 0013: Script scheduling — next_run_at/last_run_at on user_scripts + scheduler index.
-- Supports the cron runner (engine/src/scheduler.ts): next_run_at is polled every
-- 60 s; last_run_at is a denormalized stamp for the list view.

alter table "user_scripts" add column "next_run_at" timestamp with time zone;
alter table "user_scripts" add column "last_run_at" timestamp with time zone;

create index "user_scripts_scheduled"
  on "user_scripts" ("org_id", "trigger_point", "is_active", "next_run_at");
