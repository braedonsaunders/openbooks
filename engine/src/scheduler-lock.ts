/**
 * The one home for scheduler tick-claim identities and the one shared
 * tick-claim primitive. Every global-scan topology — the standalone report
 * scheduler (engine/src/worker/scheduler.ts) and the broader web scheduler
 * (engine/src/scheduler.ts) — claims its tick through the same session-level
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
 * The primitive itself lives beside the report scheduler (its original author)
 * and is re-exported here so callers have a single import surface. Like every
 * session lock it dies with its connection: released in a finally block on
 * success and error paths, with a broken connection discarded rather than
 * returned to the pool so a stale claim can never leak back into circulation.
 */
export { TICK_LOCK_KEY as WORKER_TICK_LOCK_KEY, withTickClaim } from "./worker/scheduler.ts";

/** Cross-replica identity of the web scheduler's full tick (all global scans). */
export const WEB_TICK_LOCK_KEY = "openbooks:web-scheduler-tick";
