import { pool, withBypassContext } from "../db.ts";
import { dispatchQueuedReportRuns, dispatchReportDeliveries, materializeDueReportRuns } from "../report-delivery.ts";
import { ensureScanOutboxRows, processDueSchedulerOutbox } from "../scheduler-outbox.ts";
import { processDuePostingEffects } from "../posting-effects.ts";
import { processGateTimers } from "../flows/gates.ts";
import { runInSpan } from "../telemetry.ts";

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
 * (pg_try_advisory_lock on TICK_LOCK_KEY) so multi-replica deployments cannot
 * double-dispatch scheduled work. The module-local `running` flag only stops
 * overlap within one process; the lock is what excludes the other replicas.
 * Like every session lock it dies with its connection: it is released in the
 * finally block on both success and error paths, and if the connection broke
 * mid-tick the client is discarded rather than returned to the pool, so a
 * stale claim can never leak back into circulation.
 */
const TICK_INTERVAL_MS = 60_000;
const TICK_LOCK_KEY = "openbooks:report-scheduler-tick";
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

/**
 * Run `body` under the cross-replica tick claim. Returns null when another
 * replica holds the claim (body never runs); otherwise resolves with body's
 * result after releasing the claim, including when body throws.
 */
export async function withTickClaim<T>(body: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  let held = false;
  try {
    const claimed = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [TICK_LOCK_KEY],
    );
    if (claimed.rows[0]?.locked !== true) {
      console.log("[report-scheduler] tick claim held by another replica; skipping");
      return null;
    }
    held = true;
    return await body();
  } finally {
    let discard: Error | undefined;
    if (held) {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [TICK_LOCK_KEY]);
      } catch (e) {
        // The session may have died while held; destroy this connection so the
        // lock dies with it instead of being reused while still locked.
        discard = e as Error;
      }
    }
    client.release(discard);
  }
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await withTickClaim(async () => {
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
