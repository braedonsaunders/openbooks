-- Live migration progress: sync_runs.progress (phase / X-of-Y counts), polled
-- by the platform page while a run is in flight.
ALTER TABLE "sync_runs" ADD COLUMN IF NOT EXISTS "progress" jsonb NOT NULL DEFAULT '{}'::jsonb;
