import { sql } from "drizzle-orm";
import { enqueueBackupRun } from "@openbooks/jobs";
import {
  auditBackupEvent,
  computeNextRunAt,
  deleteBackupObject,
  headBackupObject,
} from "../backup.ts";
import { db } from "../db.ts";

/**
 * Backup scheduler — polls for enabled backup_policies whose next_run_at is
 * due, claims each by atomically advancing next_run_at (the UPDATE is the
 * single-fire guard across worker instances), then inserts a 'queued'
 * backup_runs ledger row and enqueues its execution.
 *
 * Also reconciles two failure shapes:
 *   - a run with no worker heartbeat for >6h means the worker died mid-export
 *     → reconcile it (its next_run_at already advanced, so the schedule moves on);
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
    // Reconcile deterministic upload intents left by a worker failure. A fully
    // uploaded object (matching both ledger hash and size) is finalized; an
    // absent/mismatched object is cleaned and failed. Storage outages leave the
    // row running so a later tick can decide without destroying evidence.
    const staleRunning = (await db.execute(sql`
      select id, org_id, object_key, sha256, byte_size::text as byte_size
        from backup_runs
       where status = 'running' and updated_at < now() - interval '6 hours'
       limit 25`)) as unknown as {
      rows: { id: string; org_id: string; object_key: string | null; sha256: string | null; byte_size: string | null }[];
    };
    for (const run of staleRunning.rows) {
      let recovered = false;
      if (run.object_key && run.sha256 && run.byte_size) {
        try {
          const object = await headBackupObject(run.object_key);
          recovered = object.Metadata?.sha256 === run.sha256 && String(object.ContentLength) === run.byte_size;
          if (!recovered) await deleteBackupObject(run.object_key);
        } catch (error) {
          if ((error as { name?: string }).name !== "NotFound" && (error as { name?: string }).name !== "NoSuchKey") {
            console.error(`[backup-scheduler] cannot reconcile ${run.id}; will retry:`, (error as Error).message);
            continue;
          }
        }
      }
      if (recovered) {
        const finalized = (await db.execute(sql`
          update backup_runs
             set status = 'completed', error = null, completed_at = now(), updated_at = now()
           where id = ${run.id} and status = 'running'
             and updated_at < now() - interval '6 hours'
           returning id`)) as unknown as { rows: { id: string }[] };
        if (finalized.rows[0]) {
          await auditBackupEvent({
            orgId: run.org_id,
            tableName: "backup_runs",
            rowId: run.id,
            actorId: null,
            changes: { event: "backup_upload_reconciled", sha256: run.sha256 },
          });
        }
      } else {
        await db.execute(sql`
          update backup_runs
             set status = 'failed', object_key = null,
                 error = 'worker stopped before the upload could be verified',
                 completed_at = now(), updated_at = now()
           where id = ${run.id} and status = 'running'
             and updated_at < now() - interval '6 hours'`);
      }
    }

    // A synchronous cleanup may have failed after a known failed run. Retry
    // those deterministic keys until no hidden object remains.
    const failedUploads = (await db.execute(sql`
      select id, object_key from backup_runs
       where status = 'failed' and object_key is not null and purged_at is null
       limit 25`)) as unknown as { rows: { id: string; object_key: string }[] };
    for (const run of failedUploads.rows) {
      try {
        await deleteBackupObject(run.object_key);
        await db.execute(sql`
          update backup_runs set object_key = null, updated_at = now()
           where id = ${run.id} and status = 'failed' and object_key = ${run.object_key}`);
      } catch (error) {
        console.error(`[backup-scheduler] orphan cleanup failed for ${run.object_key}:`, (error as Error).message);
      }
    }

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
      let run: { rows: { id: string }[] };
      try {
        // One statement is the atomic boundary: if the ledger insert fails
        // (including because a manual run is already in flight), PostgreSQL
        // also rolls back the policy advance. A later tick can retry it.
        run = (await db.execute(sql`
          with claimed as (
            update backup_policies
               set next_run_at = ${next.toISOString()}, updated_at = now()
             where org_id = ${policy.org_id}
               and enabled
               and next_run_at <= now()
             returning org_id
          )
          insert into backup_runs (org_id, kind, status)
          select org_id, 'scheduled', 'queued' from claimed
          returning id`)) as unknown as { rows: { id: string }[] };
      } catch (error) {
        const postgresError = error as { code?: string; constraint?: string };
        if (
          postgresError.code === "23505" &&
          postgresError.constraint === "backup_runs_one_inflight_per_org"
        ) {
          continue;
        }
        throw error;
      }
      if (run.rows.length === 0) continue;
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
