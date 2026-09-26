/** Rendezvous for lock-wait race tests: wait until a concurrent backend parks
 * on a lock held by the caller's open transaction.
 *
 * Poll pg_locks for an ungranted waiter whose (locktype, transactionid)
 * matches a granted lock on this backend. pg_stat_activity must not be used
 * for this: inside an open transaction its rows pin to the transaction's
 * first statistics snapshot, so a poll loop whose first read runs before the
 * waiter blocks misses every later poll for the whole rendezvous. pg_locks
 * reflects the lock manager directly and stays live inside the holder
 * transaction (this also retires the per-file pg_stat_clear_snapshot
 * workarounds). Scoping to this backend's locks keeps unrelated Lock
 * waiters elsewhere from satisfying the barrier. */
import type { Client } from "pg";

const WAITER_SQL = `select count(*)::int as n from pg_locks blocked
  where not blocked.granted and blocked.pid <> pg_backend_pid() and exists (
    select 1 from pg_locks mine where mine.granted and mine.pid = pg_backend_pid()
    and mine.locktype = blocked.locktype
    and mine.transactionid is not distinct from blocked.transactionid)`;

export interface LockWaiterOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

export async function waitForLockWaiter(
  holder: Pick<Client, "query">,
  options: LockWaiterOptions = {},
): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 25, label = "the concurrent operation" } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = (await holder.query<{ n: number }>(WAITER_SQL)).rows[0]?.n ?? 0;
    if (n > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label} to park on this transaction's lock: ` +
          `no ungranted pg_locks waiter was observed, so it either never reached the locked row or settled before blocking`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
