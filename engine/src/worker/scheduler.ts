import { withBypassContext } from "../platform/db.ts";
import { dispatchQueuedReportRuns, dispatchReportDeliveries, materializeDueReportRuns } from "../delivery/report-delivery.ts";
import { ensureScanOutboxRows, processDueSchedulerOutbox } from "../scheduling/outbox.ts";
import { processDuePostingEffects } from "../ledger/posting-effects.ts";
import { processGateTimers } from "../flows/gates.ts";
import { runInSpan } from "../platform/telemetry.ts";
import { WORKER_TICK_LOCK_KEY, withTickClaim } from "../scheduling/lock.ts";

/**
 * The database is the durable scheduler/outbox; Redis queues are rebuilt from
 * it on every tick. A crash between commit and enqueue therefore loses nothing.
 *
 * Report delivery, scheduler_outbox (dunning / billing / FX / approval
 * escalations), and posting_effects all scan ACROSS organizations, so each
 * crosses an explicit trusted boundary. A timer callback holds no request
 * store: without that boundary the connection layer denies by default and
 * every scan returns zero rows and no error — scheduled work would simply
 * never run.
 *
 * Ticks are claimed with a session-level Postgres advisory lock
 * (pg_try_advisory_lock on a per-topology lock identity) so multi-replica
 * deployments cannot double-dispatch scheduled work. The module-local `running`
 * flag only stops overlap within one process; the lock is what excludes the
 * other replicas. Like every session lock it dies with its connection: it is
 * released in the finally block on both success and error paths, and if the
 * connection broke mid-tick the client is discarded rather than returned to the
 * pool, so a stale claim can never leak back into circulation.
 *
 * Ticks are claimed through the shared primitive in engine/src/scheduling/lock.ts is the
 * shared façade where every scheduler topology picks its lock identity and
 * borrows the same primitive, so the report-scheduler tick and the broader web
 * scheduler tick each exclude their own replicas without suppressing each
 * other's non-identical duty sets.
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

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await withTickClaim(WORKER_TICK_LOCK_KEY, async () => {
      // One span per claimed pass: every outbox/report attempt below joins it
      // as a child, so a collector shows the full tick tree per replica.
      await runInSpan("scheduler.tick", undefined, async () => {
        await withBypassContext(() => materializeDueReportRuns());
        await withBypassContext(() => dispatchQueuedReportRuns());
        await withBypassContext(() => dispatchReportDeliveries());
        await withBypassContext(() => ensureScanOutboxRows());
        await processGateTimers();
        await withBypassContext(() => processDueSchedulerOutbox());
        await withBypassContext(() => processDuePostingEffects());
      });
    });
  } catch (e) {
    console.error("[report-scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}
