import { sql } from "drizzle-orm";
import { enqueueSandboxOp } from "@openbooks/jobs";
import { db, longPool, withBypassContext } from "../platform/db.ts";
import { REFRESH_CLONE_PROOF_PREFIX, sandboxRefreshLockKey } from "../sandbox/lifecycle.ts";

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

/**
 * Age-based reaper for tick claims whose job was lost. The tick flips
 * ready→refreshing BEFORE the Redis enqueue; when the enqueue throws, the
 * catch above releases the claim — but an accepted-then-lost job (Redis
 * failover between accept and delivery) strands the sandbox in 'refreshing'
 * forever: the tick selects only 'ready', and delete refuses 'refreshing'.
 * A stale UNPROVEN claim (no worker proof token, older than
 * STALE_SANDBOX_CLAIM_MS) returns to 'ready' with a named recovery note so
 * the next tick re-queues it. Proven rows belong to a live (or
 * worker-owned) refresh and are never touched by age alone.
 */
export const STALE_SANDBOX_CLAIM_MS = 60 * 60 * 1000;

export type SandboxRefreshQueueLiveness = "live" | "dead" | "unknown";

const LIVE_SANDBOX_JOB_STATES = new Set([
  "active", "delayed", "paused", "prioritized", "waiting", "waiting-children",
]);

export async function sandboxRefreshQueueLiveness(
  sandboxId: string,
  windowMs: number,
  getJobState: (jobId: string) => Promise<string | null>,
): Promise<SandboxRefreshQueueLiveness> {
  const bucket = Math.floor(Date.now() / windowMs);
  let unknown = false;
  for (const jobId of [`sbxsched|${sandboxId}|${bucket}`, `sbxsched|${sandboxId}|${bucket - 1}`]) {
    let state: string | null;
    try {
      state = await getJobState(jobId);
    } catch {
      // An unavailable queue cannot prove that a claimed refresh is dead.
      unknown = true;
      continue;
    }
    if (state === null) continue;
    if (LIVE_SANDBOX_JOB_STATES.has(state)) return "live";
    if (state !== "failed" && state !== "completed") unknown = true;
  }
  return unknown ? "unknown" : "dead";
}

async function getSandboxRefreshJobState(jobId: string): Promise<string | null> {
  const { getSandboxQueue } = await import("@openbooks/jobs");
  const job = await getSandboxQueue().getJob(jobId);
  return job ? job.getState() : null;
}

async function withRefreshRecoveryLock(sandboxId: string, recover: () => Promise<boolean>): Promise<boolean> {
  const client = await longPool.connect();
  const key = sandboxRefreshLockKey(sandboxId);
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [key],
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return false;
    return await recover();
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => undefined);
    }
    client.release();
  }
}

export async function releaseStaleSandboxClaims(
  getJobState: (jobId: string) => Promise<string | null> = getSandboxRefreshJobState,
): Promise<number> {
  const stale = (await withBypassContext(() =>
    db.execute<{ id: string; orgId: string; cadence: string | null; lastError: string | null }>(sql`
      select id, org_id as "orgId", refresh_schedule as "cadence", last_error as "lastError"
        from sandboxes
       where status = 'refreshing'
         and updated_at < now() - make_interval(secs => ${STALE_SANDBOX_CLAIM_MS / 1000})
    `)));
  let released = 0;
  for (const row of stale.rows) {
    const proofExists = row.lastError?.startsWith(REFRESH_CLONE_PROOF_PREFIX) === true;
    if (!proofExists) {
      const window = (row.cadence && CADENCE_MS[row.cadence]) || TICK_INTERVAL_MS;
      const liveness = await sandboxRefreshQueueLiveness(row.id, window, getJobState);
      if (liveness !== "dead") continue;
    }
    const recovered = await withRefreshRecoveryLock(row.id, async () => {
      const message = proofExists
        ? "refresh lease expired: worker stopped during clone verification; rerun refresh or delete this sandbox"
        : "refresh worker never started: stale scheduler claim released for re-queue";
      const done = await withBypassContext(() => db.execute(sql`
        update sandboxes set status = ${proofExists ? "failed" : "ready"},
               last_error = ${message}, updated_at = now()
         where id = ${row.id} and org_id = ${row.orgId} and status = 'refreshing'
           and last_error is not distinct from ${row.lastError}
           and updated_at < now() - make_interval(secs => ${STALE_SANDBOX_CLAIM_MS / 1000})
      `));
      if (done.rowCount) {
        console.error(`[sandbox-scheduler] ${proofExists ? "failed" : "released"} stale refresh for sandbox ${row.id}: ${message}`);
      }
      return Boolean(done.rowCount);
    });
    if (recovered) {
      released += 1;
    }
  }
  return released;
}

export async function tick(
  enqueue: typeof enqueueSandboxOp = enqueueSandboxOp,
): Promise<void> {
  if (running) return;
  running = true;
  try {
    await releaseStaleSandboxClaims();
    // A timer tick carries no request context, so this cross-tenant scan and
    // its claim must cross an explicit trusted boundary — otherwise RLS denies
    // by default and the scanner silently sees no sandboxes at all.
    const due = (await withBypassContext(() =>
      db.execute<{
        id: string;
        orgId: string;
        cadence: string;
        keep: boolean | null;
        ageSec: string;
      }>(sql`
      select id, org_id as "orgId", refresh_schedule as "cadence", refresh_keep_customizations as "keep",
             extract(epoch from (now() - coalesce(last_refresh_at, created_at))) as "ageSec"
        from sandboxes
       where status = 'ready' and refresh_schedule is not null
       limit 50`)));

    for (const s of due.rows) {
      const window = CADENCE_MS[s.cadence];
      if (!window || Number(s.ageSec) * 1000 < window) continue;
      // Claim: flip ready→refreshing so only one scanner fires it.
      const claimed = (await withBypassContext(() =>
        db.execute(sql`
        update sandboxes set status = 'refreshing'
         where id = ${s.id} and org_id = ${s.orgId} and status = 'ready'`)));
      if (!claimed.rowCount) continue;
      try {
        // Hand back to 'ready' is done by the refresh op; enqueue it.
        await enqueue(
          { op: "refresh", sandboxId: s.id, keepCustomizations: s.keep !== false, initiator: { systemReason: "scheduled sandbox refresh" } },
          { jobId: `sbxsched|${s.id}|${Math.floor(Date.now() / window)}` },
        );
      } catch (e) {
        // The claim above already committed: without a queued job no worker
        // will ever run the refresh, so release the claim instead of wedging
        // the sandbox in 'refreshing' (the backup-run route releases its
        // in-flight guard the same way when its enqueue fails). The next tick
        // retries with the same deterministic jobId.
        const message = ((e as Error).message || String(e)).slice(0, 2000);
        await withBypassContext(() =>
          db.execute(sql`
          update sandboxes set status = 'ready', last_error = ${message}, updated_at = now()
           where id = ${s.id} and org_id = ${s.orgId} and status = 'refreshing'`));
        console.error(`[sandbox-scheduler] enqueue failed for sandbox ${s.id}; claim released:`, message);
      }
    }
  } catch (e) {
    console.error("[sandbox-scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}
