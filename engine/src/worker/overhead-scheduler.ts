import { sql } from "drizzle-orm";
import { db, pool, withBypassContext, withOrgContext } from "../db.ts";
import { appBaseUrl } from "./render-client.ts";

/**
 * Overhead rate-lifecycle scheduler — for orgs whose
 * settings.overheadRateLifecycle.mode = 'scheduled', publish the live
 * per-department composite rates into the standard rate card at each period
 * start (monthly or quarterly cadence). Publishing itself happens through the
 * web app's internal endpoint (the True Cost engine lives in web/lib).
 *
 * Idempotent by construction: each attempt claims a session advisory lock keyed
 * overhead-publish:<org>:<effectiveFrom> on its own pooled connection, so
 * overlapping workers/ticks skip cleanly instead of double-firing the probe +
 * POST race. Within a claim, an org is skipped when a standard per-hour row
 * already exists with the period's effective_from — one publish per org per
 * period (the endpoint replaces rather than stacks, which remains the backstop
 * if a worker dies while holding the lock).
 */
const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** First day of the current cadence period, as ISO. */
export function periodStartFor(cadence: "monthly" | "quarterly", now = new Date()): string {
  const month = cadence === "quarterly" ? Math.floor(now.getUTCMonth() / 3) * 3 : now.getUTCMonth();
  return new Date(Date.UTC(now.getUTCFullYear(), month, 1)).toISOString().slice(0, 10);
}

export function startOverheadScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  timer.unref?.();
  void tick();
}

export function stopOverheadScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Discovering WHICH orgs opted into scheduled publishing is org-spanning
    // work and crosses an explicit trusted boundary; the per-org idempotency
    // probe then runs inside that org's own RLS scope. Without either, the
    // contextless timer tick is denied by default and publishes nothing.
    const orgs = await withBypassContext(() =>
      db.execute<{ id: string; cadence: string | null }>(sql`
      select id, settings->'overheadRateLifecycle'->>'cadence' as cadence
        from orgs
       where settings->'overheadRateLifecycle'->>'mode' = 'scheduled'`));
    for (const org of orgs.rows) {
      const cadence = org.cadence === "quarterly" ? "quarterly" : "monthly";
      await publishForOrg(org.id, periodStartFor(cadence));
    }
  } catch (e) {
    console.error("[overhead-scheduler] tick failed:", (e as Error).message);
  } finally {
    running = false;
  }
}

/**
 * One claimed publish attempt for a single org+period. The probe and POST run
 * under pg_try_advisory_lock(hashtextextended('overhead-publish:<org>:<from>',0))
 * held session-level on one pooled connection — checked out inside the org's RLS
 * scope so the probe sees tenant rows. A competing tick fails the try-lock and
 * skips cleanly instead of double-firing. The lock releases in the finally
 * block; if the session broke meanwhile, the connection is discarded so the
 * lock dies with it rather than leaking back into the pool.
 */
async function publishForOrg(orgId: string, effectiveFrom: string): Promise<void> {
  const lockKey = `overhead-publish:${orgId}:${effectiveFrom}`;
  await withOrgContext(orgId, async () => {
    const client = await pool.connect();
    let lockHeld = false;
    try {
      const claimed = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
        [lockKey],
      );
      if (claimed.rows[0]?.locked !== true) {
        console.log(`[overhead-scheduler] org ${orgId}: publish claim held elsewhere for ${effectiveFrom}; skipping`);
        return;
      }
      lockHeld = true;
      const existing = await client.query(
        `select 1 from overhead_rates
          where org_id = $1 and rate_kind = 'per_hour' and method = 'standard'
            and effective_from = $2 limit 1`,
        [orgId, effectiveFrom],
      );
      if ((existing.rowCount ?? 0) > 0) return;
      try {
        const res = await fetch(`${appBaseUrl()}/api/internal/overhead/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-token": process.env.OPENBOOKS_INTERNAL_TOKEN || "" },
          body: JSON.stringify({ orgId, effectiveFrom }),
          signal: AbortSignal.timeout(120_000),
        });
        const j = (await res.json().catch(() => ({}))) as { published?: number; error?: string };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        console.log(`[overhead-scheduler] org ${orgId}: published ${j.published ?? 0} rates effective ${effectiveFrom}`);
      } catch (e) {
        console.error(`[overhead-scheduler] org ${orgId} publish failed:`, (e as Error).message);
      }
    } finally {
      let discard: Error | undefined;
      if (lockHeld) {
        try {
          await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
        } catch (e) {
          discard = e as Error;
        }
      }
      client.release(discard);
    }
  });
}
