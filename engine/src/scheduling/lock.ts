/**
 * The one home for scheduler tick-claim identities and the one shared
 * tick-claim primitive. Every global-scan topology — the standalone report
 * scheduler (engine/src/worker/scheduler.ts) and the broader web scheduler
 * (engine/src/scheduling/scheduler.ts) — claims its tick through the same session-level
 * Postgres advisory lock, each under its OWN identity:
 *
 *   - Replicas of ONE topology are mutually exclusive, so N web servers can no
 *     longer all run SFTP imports / bank feeds / scheduled scripts on every
 *     60 s boundary.
 *   - Two topologies with non-identical duty sets never suppress each other:
 *     a worker holding WORKER_TICK_LOCK_KEY does not stall web-only duties,
 *     and vice versa. Shared duties stay safe through their own per-duty CAS,
 *     lease claims, and idempotency keys; the tick claim is only the coarse
 *     fan-out gate per topology.
 *
 * The primitive itself lives here (moved from the report scheduler so the
 * scheduling module no longer depends on the worker); the report scheduler
 * borrows it like every other topology. Like
 * every session lock it dies with its connection: released in a finally block
 * on success and error paths, with a broken connection discarded rather than
 * returned to the pool so a stale claim can never leak back into circulation.
 */
import { pool } from "../platform/db.ts";

/** Cross-replica identity of the report scheduler's tick. */
export const WORKER_TICK_LOCK_KEY = "openbooks:report-scheduler-tick";

/**
 * Run `body` under the cross-replica tick claim for `lockKey`. Returns null
 * when another replica holds the claim (body never runs); otherwise resolves
 * with body's result after releasing the claim, including when body throws.
 * Each topology passes its own identity, so two topologies with different
 * duty sets never suppress each other while the replicas of ONE topology
 * stay mutually exclusive.
 */
export async function withTickClaim<T>(lockKey: string, body: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  let held = false;
  try {
    const claimed = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [lockKey],
    );
    if (claimed.rows[0]?.locked !== true) {
      console.log(`[${lockKey}] tick claim held by another replica; skipping`);
      return null;
    }
    held = true;
    return await body();
  } finally {
    let discard: Error | undefined;
    if (held) {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      } catch (e) {
        // The session may have died while held; destroy this connection so the
        // lock dies with it instead of being reused while still locked.
        discard = e as Error;
      }
    }
    client.release(discard);
  }
}

/** Cross-replica identity of the web scheduler's full tick (all global scans). */
export const WEB_TICK_LOCK_KEY = "openbooks:web-scheduler-tick";
