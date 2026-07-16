import { sql } from "drizzle-orm";
import { computeNextRunAt } from "@openbooks/reports";
import { enqueueReportRun } from "@openbooks/jobs";
import { db } from "../db.ts";

/**
 * Report-schedule scanner — polls every 60s for active report_schedules whose
 * next_run_at has passed, atomically claims each (UPDATE … WHERE next_run_at =
 * $old), advances next_run_at to the next cadence tick, and enqueues a `reports`
 * job. Single-scanner claim means only one worker instance fires each schedule.
 */
const TICK_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startReportScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref?.();
  void tick();
}

export function stopReportScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = (await db.execute(sql`
      select id, org_id as "orgId", definition_id as "definitionId", cadence,
             day_of_week as "dayOfWeek", day_of_month as "dayOfMonth", hour, minute,
             timezone, recipient_emails as "recipientEmails", next_run_at as "nextRunAt"
        from report_schedules
       where active and next_run_at <= now()
       order by next_run_at
       limit 50
    `)) as unknown as {
      rows: {
        id: string; orgId: string; definitionId: string; cadence: "daily" | "weekly" | "monthly";
        dayOfWeek: number | null; dayOfMonth: number | null; hour: number; minute: number;
        timezone: string; recipientEmails: string[] | null; nextRunAt: Date;
      }[];
    };

    for (const s of due.rows) {
      const next = computeNextRunAt(
        { cadence: s.cadence, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, hour: s.hour, minute: s.minute, timezone: s.timezone },
        new Date(),
      );
      // Claim: only one scanner wins the CAS on next_run_at.
      const claimed = (await db.execute(sql`
        update report_schedules set next_run_at = ${next}, updated_at = now()
         where id = ${s.id} and next_run_at = ${s.nextRunAt}
      `)) as unknown as { rowCount?: number };
      if (!claimed.rowCount) continue;

      const recipients = Array.isArray(s.recipientEmails) ? s.recipientEmails : [];
      if (recipients.length === 0) continue;

      await enqueueReportRun(
        { orgId: s.orgId, definitionId: s.definitionId, scheduleId: s.id, recipients },
        { jobId: `sched|${s.id}|${s.nextRunAt instanceof Date ? s.nextRunAt.toISOString() : String(s.nextRunAt)}` },
      );
    }
  } catch (e) {
    console.error("[report-scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}
