import { sql } from "drizzle-orm";
import { businessToday, calendarQuarterBounds, startOfMonth } from "../platform/business-date.ts";
import { db, pool, withBypassContext, withOrgContext } from "../platform/db.ts";
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

/**
 * Publish-failure retry state (C-55). A dead endpoint must not be hammered
 * identically every hourly tick with only a console.error to show for it:
 * consecutive failures back off, and every failure raises one named,
 * unread-while-broken operator notice (deduped, resolved on success).
 */
export const OVERHEAD_PUBLISH_FAILED_NOTICE_KIND = "overhead_publish_failed";
const OVERHEAD_SETUP_HREF = "/admin/setup/overhead";
const OVERHEAD_PUBLISH_MAX_BACKOFF_MS = 8 * 3_600_000;

export type OverheadPublishRetryState = {
  consecutiveFailures: number;
  nextAttemptAtMs: number;
};

const publishRetry = new Map<string, OverheadPublishRetryState>();

/**
 * Backoff after consecutive POST failures: the first failure retries next
 * tick, then 1h, 2h, 4h, capped at 8h. Pure for the durability tests.
 */
export function overheadPublishRetryDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return 0;
  return Math.min(2 ** (consecutiveFailures - 2) * 3_600_000, OVERHEAD_PUBLISH_MAX_BACKOFF_MS);
}

/** Whether a publish may be attempted now under the retry state. Pure. */
export function overheadPublishAttemptDue(
  state: OverheadPublishRetryState | undefined,
  nowMs: number,
): boolean {
  return !state || state.nextAttemptAtMs <= nowMs;
}

/** Test seam: clear this process's publish retry state. Production never calls this. */
export function resetOverheadPublishRetryForTest(): void {
  publishRetry.clear();
}

/**
 * Raise the named failure notice for one org: active super-admins and
 * holders of a role directly granting admin.setup.manage (the SFTP
 * unbound-schedule convention — a notification target is not an authz
 * decision). Idempotent: a second pass finds the unread notice and writes
 * nothing, so the tick never spams. Runs inside the org's RLS scope like
 * the publish itself. Raw SQL, not the inbox helper, so the worker module
 * gains no inbox edge.
 */
export async function ensureOverheadPublishFailedNotice(
  orgId: string,
  effectiveFrom: string,
  error: string,
): Promise<number> {
  const recipients = (await db.execute<{ id: string }>(sql`
    select distinct u.id::text as id
      from users u
      left join role_assignments a on a.user_id = u.id and a.org_id = u.org_id
      left join app_roles r on r.id = a.role_id and r.org_id = a.org_id
     where u.org_id = ${orgId} and u.is_active
       and (u.is_super_admin or (r.permissions ? 'admin.setup.manage'))
  `)).rows;
  if (recipients.length === 0) return 0;
  let written = 0;
  for (const recipient of recipients) {
    const existing = (await db.execute<{ one: number }>(sql`
      select 1 as one from notifications
       where org_id = ${orgId} and user_id = ${recipient.id}::uuid
         and kind = ${OVERHEAD_PUBLISH_FAILED_NOTICE_KIND} and href = ${OVERHEAD_SETUP_HREF} and read_at is null
       limit 1
    `)).rows[0];
    if (existing) continue;
    const title = `Overhead scheduled publish failed for ${effectiveFrom}`;
    const body =
      `Scheduled overhead publish for ${effectiveFrom} failed: ${error}. ` +
      "The published rate card stays stale until a publish succeeds. " +
      "Check the app endpoint and OPENBOOKS_INTERNAL_TOKEN, then wait for the next attempt — " +
      "retries back off automatically after repeated failures. " +
      "See Company Settings → Overhead.";
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into notifications (org_id, user_id, kind, title, body, href)
      values (${orgId}, ${recipient.id}::uuid, ${OVERHEAD_PUBLISH_FAILED_NOTICE_KIND}, ${title}, ${body}, ${OVERHEAD_SETUP_HREF})
      returning id
    `)).rows[0]?.id;
    if (!inserted) throw new Error("the overhead-publish failure notice was not stored — no row was written; retry the action");
    written += 1;
  }
  return written;
}

/** Resolve the failure notices after a successful publish, so a later failure re-fires. */
export async function resolveOverheadPublishFailedNotices(orgId: string): Promise<number> {
  const resolved = (await db.execute<{ n: number }>(sql`
    update notifications set read_at = now(), updated_at = now()
     where org_id = ${orgId} and kind = ${OVERHEAD_PUBLISH_FAILED_NOTICE_KIND}
       and href = ${OVERHEAD_SETUP_HREF} and read_at is null
    returning 1 as n
  `)).rows.length;
  return resolved;
}

/** First day of the cadence period that contains the org calendar day. */
export function periodStartFor(cadence: "monthly" | "quarterly", today: string): string {
  return cadence === "quarterly" ? calendarQuarterBounds(today).start : startOfMonth(today);
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
       where settings->'overheadRateLifecycle'->>'mode' = 'scheduled'
         -- Registry fallback shape (non-boolean stored values fall back to
         -- the default instead of throwing 22P02).
         and case (settings->'features'->>'projects') when 'true' then true when 'false' then false else true end`));
    for (const org of orgs.rows) {
      const cadence = org.cadence === "quarterly" ? "quarterly" : "monthly";
      const today = await businessToday(org.id);
      await publishForOrg(org.id, periodStartFor(cadence, today));
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
      // Back off while the endpoint keeps failing instead of hammering it
      // identically every hourly tick. The skip is named; the retry state
      // clears on the next success.
      const retryKey = `${orgId}:${effectiveFrom}`;
      const retry = publishRetry.get(retryKey);
      const nowMs = Date.now();
      if (!overheadPublishAttemptDue(retry, nowMs)) {
        console.warn(
          `[overhead-scheduler] org ${orgId}: publish backing off until ` +
            `${new Date(retry!.nextAttemptAtMs).toISOString()} ` +
            `after ${retry!.consecutiveFailures} consecutive failures; skipping this tick`,
        );
        return;
      }
      try {
        const res = await fetch(`${appBaseUrl()}/api/internal/overhead/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-token": process.env.OPENBOOKS_INTERNAL_TOKEN || "" },
          body: JSON.stringify({ orgId, effectiveFrom }),
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        });
        const j = (await res.json().catch(() => ({}))) as { published?: number; error?: string };
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        publishRetry.delete(retryKey);
        await resolveOverheadPublishFailedNotices(orgId);
        console.log(`[overhead-scheduler] org ${orgId}: published ${j.published ?? 0} rates effective ${effectiveFrom}`);
      } catch (e) {
        const message = (e as Error).message;
        const failures = (retry?.consecutiveFailures ?? 0) + 1;
        publishRetry.set(retryKey, {
          consecutiveFailures: failures,
          nextAttemptAtMs: nowMs + overheadPublishRetryDelayMs(failures),
        });
        console.error(`[overhead-scheduler] org ${orgId} publish failed (attempt ${failures}):`, message);
        try {
          await ensureOverheadPublishFailedNotice(orgId, effectiveFrom, message);
        } catch (noticeError) {
          console.error(
            `[overhead-scheduler] org ${orgId}: failure notice could not be stored:`,
            noticeError instanceof Error ? noticeError.message : noticeError,
          );
        }
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
