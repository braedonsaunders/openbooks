import { eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { runScheduledScript, computeNextRunAt } from "./scripting.ts";

/**
 * Scheduled-script runner — a real cron-driven loop that polls every 60 s for
 * active scheduled scripts whose next_run_at has passed, runs them, and
 * advances next_run_at to the next cron tick.
 *
 * Single-process (no worker queue); fine for pre-launch single-instance. The
 * UPDATE … WHERE next_run_at = $old RETURNING pattern in tick() naturally
 * serializes when horizontal scaling lands.
 *
 * Started lazily by ensureScheduler() (idempotent singleton) via
 * web/instrumentation.ts so it only runs in the server process.
 */

const TICK_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function ensureScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref?.();
  tick();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // NOTE: this org-less scan needs a supporting index on user_scripts with
    // column order (trigger_point, is_active, next_run_at).
    const due = (await db.execute(sql`
      select id, org_id as "orgId", cron, next_run_at as "nextRunAt"
        from user_scripts
       where trigger_point = 'scheduled' and is_active and next_run_at <= now()
       order by next_run_at
    `)) as unknown as { rows: { id: string; orgId: string; cron: string | null; nextRunAt: Date }[] };

    for (const s of due.rows) {
      // Claim the run by advancing next_run_at in the same statement. The
      // WHERE next_run_at = $old guard means only one claimer wins; if the
      // process dies mid-run the script stays scheduled for its next tick.
      const next = s.cron ? computeNextRunAt(s.cron) : null;
      const claimed = (await db.execute(sql`
        update user_scripts set next_run_at = ${next}
         where id = ${s.id} and next_run_at = ${s.nextRunAt}
      `)) as unknown as { rowCount?: number };
      if (!claimed.rowCount) continue; // someone else claimed it (or it changed)

      try {
        await runScheduledScript(s.id, s.orgId);
      } catch (e) {
        // runScheduledScript writes its own script_runs row for script
        // failures; this catches host-side failures (db insert etc.).
        console.error(`[scheduler] script ${s.id} run failed:`, e);
      }
    }
  } catch (e) {
    // Never let a tick rejection escape setInterval — an unhandled rejection
    // would take down the whole server process on a transient DB error.
    console.error("[scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}
