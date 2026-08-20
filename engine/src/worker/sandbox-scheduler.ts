import { sql } from "drizzle-orm";
import { enqueueSandboxOp } from "@openbooks/jobs";
import { db, withBypassContext } from "../db.ts";

/**
 * Sandbox refresh scanner — polls every 5 min for ready sandboxes whose
 * `refresh_schedule` cadence is due (based on last_refresh_at) and enqueues a
 * non-destructive refresh. Cadence is a simple keyword (hourly|daily|weekly)
 * rather than full cron — good enough for "keep my sandbox fresh" and free of a
 * cron-parser dependency. The status flip to 'refreshing' at claim time doubles
 * as the single-fire guard.
 */
const TICK_INTERVAL_MS = 5 * 60_000;
const CADENCE_MS: Record<string, number> = {
  hourly: 3600_000,
  daily: 24 * 3600_000,
  weekly: 7 * 24 * 3600_000,
};
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startSandboxScheduler(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref?.();
  void tick();
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // A timer tick carries no request context, so this cross-tenant scan and
    // its claim must cross an explicit trusted boundary — otherwise RLS denies
    // by default and the scanner silently sees no sandboxes at all.
    const due = (await withBypassContext(() =>
      db.execute(sql`
      select id, refresh_schedule as "cadence", refresh_keep_customizations as "keep",
             extract(epoch from (now() - coalesce(last_refresh_at, created_at))) as "ageSec"
        from sandboxes
       where status = 'ready' and refresh_schedule is not null
       limit 50`))) as any;

    for (const s of due.rows as any[]) {
      const window = CADENCE_MS[s.cadence];
      if (!window || s.ageSec * 1000 < window) continue;
      // Claim: flip ready→refreshing so only one scanner fires it.
      const claimed = (await withBypassContext(() =>
        db.execute(sql`
        update sandboxes set status = 'refreshing' where id = ${s.id} and status = 'ready'`))) as any;
      if (!claimed.rowCount) continue;
      // Hand back to 'ready' is done by the refresh op; enqueue it.
      await enqueueSandboxOp(
        { op: "refresh", sandboxId: s.id, keepCustomizations: s.keep !== false },
        { jobId: `sbxsched|${s.id}|${Math.floor(Date.now() / window)}` },
      );
    }
  } catch (e) {
    console.error("[sandbox-scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}
