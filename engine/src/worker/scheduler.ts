import { withBypassContext } from "../db.ts";
import { dispatchQueuedReportRuns, dispatchReportDeliveries, materializeDueReportRuns } from "../report-delivery.ts";

/**
 * The database is the durable scheduler/outbox; Redis queues are rebuilt from
 * it on every tick. A crash between commit and enqueue therefore loses nothing.
 *
 * All three phases scan the outbox ACROSS organizations, so each crosses an
 * explicit trusted boundary. A timer callback holds no request store: without
 * that boundary the connection layer denies by default and every scan returns
 * zero rows and no error — scheduled reports would simply never be delivered.
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
    await withBypassContext(() => materializeDueReportRuns());
    await withBypassContext(() => dispatchQueuedReportRuns());
    await withBypassContext(() => dispatchReportDeliveries());
  } catch (e) {
    console.error("[report-scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}
