import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { appBaseUrl } from "./render-client.ts";

/**
 * Overhead rate-lifecycle scheduler — for orgs whose
 * settings.overheadRateLifecycle.mode = 'scheduled', publish the live
 * per-department composite rates into the standard rate card at each period
 * start (monthly or quarterly cadence). Publishing itself happens through the
 * web app's internal endpoint (the True Cost engine lives in web/lib).
 *
 * Idempotent by construction: an org is skipped when a standard per-hour row
 * already exists with the period's effective_from — so the hourly poll fires
 * exactly one publish per org per period, whichever worker instance gets
 * there first (the endpoint replaces rather than stacks on races).
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
    const orgs = (await db.execute<{ id: string; cadence: string | null }>(sql`
      select id, settings->'overheadRateLifecycle'->>'cadence' as cadence
        from orgs
       where settings->'overheadRateLifecycle'->>'mode' = 'scheduled'`));
    for (const org of orgs.rows) {
      const cadence = org.cadence === "quarterly" ? "quarterly" : "monthly";
      const effectiveFrom = periodStartFor(cadence);
      const existing = (await db.execute(sql`
        select 1 from overhead_rates
         where org_id = ${org.id} and rate_kind = 'per_hour' and method = 'standard'
           and effective_from = ${effectiveFrom} limit 1`));
      if (existing.rows.length > 0) continue;
      try {
        const res = await fetch(`${appBaseUrl()}/api/internal/overhead/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-token": process.env.OPENBOOKS_INTERNAL_TOKEN || "" },
          body: JSON.stringify({ orgId: org.id, effectiveFrom }),
          signal: AbortSignal.timeout(120_000),
        });
        const j = (await res.json().catch(() => ({}))) as { published?: number; error?: string };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        console.log(`[overhead-scheduler] org ${org.id}: published ${j.published ?? 0} rates effective ${effectiveFrom}`);
      } catch (e) {
        console.error(`[overhead-scheduler] org ${org.id} publish failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.error("[overhead-scheduler] tick failed:", (e as Error).message);
  } finally {
    running = false;
  }
}
