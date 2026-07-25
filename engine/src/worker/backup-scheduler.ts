import { sql } from "drizzle-orm";
import { enqueueBackupRun } from "@openbooks/jobs";
import { computeNextRunAt } from "../backup.ts";
import { db } from "../db.ts";

/**
 * Backup scheduler — polls for enabled backup_policies whose next_run_at is
 * due, claims each by atomically advancing next_run_at (the UPDATE is the
 * single-fire guard across worker instances), then inserts a 'queued'
 * backup_runs ledger row and enqueues its execution.
 *
 * Also reconciles two failure shapes:
 *   - a run stuck 'running' for >6h means the worker died mid-export → fail it
 *     (its next_run_at already advanced, so the schedule simply moves on);
 *   - a run stuck 'queued' for >10min means its BullMQ job was lost (Redis
 *     flush etc.) → re-enqueue with the same jobId (a no-op if already queued).
 */
const TICK_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startBackupScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  timer.unref?.();
  void tick();
}

export function stopBackupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

type DuePolicy = {
  org_id: string;
  frequency: "daily" | "weekly" | "monthly";
  hour_utc: number;
  day_of_week: number;
  day_of_month: number;
};

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Worker died mid-export — surface as a failed run instead of hanging.
    await db.execute(sql`
      update backup_runs
         set status = 'failed',
             error = 'worker stopped before the export completed',
             completed_at = now(), updated_at = now()
       where status = 'running' and started_at < now() - interval '6 hours'`);

    const due = (await db.execute(sql`
      select org_id, frequency, hour_utc, day_of_week, day_of_month
        from backup_policies
       where enabled and next_run_at is not null and next_run_at <= now()
       order by next_run_at
       limit 25`)) as unknown as { rows: DuePolicy[] };

    for (const policy of due.rows) {
      // Claim: advance next_run_at past "now"; exactly one scanner wins.
      const next = computeNextRunAt(
        {
          frequency: policy.frequency,
          hourUtc: policy.hour_utc,
          dayOfWeek: policy.day_of_week,
          dayOfMonth: policy.day_of_month,
        },
        new Date(),
      );
      const claimed = (await db.execute(sql`
        update backup_policies
           set next_run_at = ${next.toISOString()}, updated_at = now()
         where org_id = ${policy.org_id} and enabled and next_run_at <= now()
         returning org_id`)) as unknown as { rowCount: number };
      if (!claimed.rowCount) continue;

      const run = (await db.execute(sql`
        insert into backup_runs (org_id, kind, status)
        values (${policy.org_id}, 'scheduled', 'queued')
        returning id`)) as unknown as { rows: { id: string }[] };
      await enqueueBackupRun(
        { op: "run", runId: run.rows[0].id, orgId: policy.org_id },
        { jobId: run.rows[0].id },
      );
      console.log(`[backup-scheduler] org ${policy.org_id}: scheduled run ${run.rows[0].id} enqueued`);
    }

    // Self-heal queued runs whose job never made it to (or survived in) Redis.
    const staleQueued = (await db.execute(sql`
      select id, org_id from backup_runs
       where status = 'queued' and created_at < now() - interval '10 minutes'
       limit 25`)) as unknown as { rows: { id: string; org_id: string }[] };
    for (const run of staleQueued.rows) {
      await enqueueBackupRun({ op: "run", runId: run.id, orgId: run.org_id }, { jobId: run.id });
    }
  } catch (e) {
    console.error("[backup-scheduler] tick failed:", (e as Error).message);
  } finally {
    running = false;
  }
}
