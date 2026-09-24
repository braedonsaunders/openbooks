import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { resetOverheadPublishRetryForTest, tick } from "./overhead-scheduler.ts";
import { periodStartFor } from "./overhead-scheduler.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("monthly period start", () => {
  assert.equal(periodStartFor("monthly", "2026-07-21"), "2026-07-01");
  assert.equal(periodStartFor("monthly", "2026-01-01"), "2026-01-01");
});

test("quarterly period start snaps to quarter", () => {
  assert.equal(periodStartFor("quarterly", "2026-07-21"), "2026-07-01");
  assert.equal(periodStartFor("quarterly", "2026-09-30"), "2026-07-01");
  assert.equal(periodStartFor("quarterly", "2026-12-31"), "2026-10-01");
  assert.equal(periodStartFor("quarterly", "2026-02-15"), "2026-01-01");
});

test("a quarterly overhead publish uses the organization's calendar day", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ orgId: string; effectiveFrom: string }> = [];
  resetOverheadPublishRetryForTest();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.endsWith("/api/internal/overhead/publish")) {
      throw new Error(`unexpected overhead scheduler request: ${url.pathname}`);
    }
    calls.push(JSON.parse(String(init?.body)) as { orgId: string; effectiveFrom: string });
    return new Response(JSON.stringify({ published: 1 }), { status: 200 });
  }) as typeof fetch;
  try {
    await db.execute(sql`
      update orgs
         set settings = settings || ${JSON.stringify({
           timeZone: "Pacific/Auckland",
           features: { projects: true },
           overheadRateLifecycle: { mode: "scheduled", cadence: "quarterly" },
         })}::jsonb
       where id = ${org.orgId}`);

    // 13:00Z on June 30 is July 1 in Auckland: Q3 locally, but Q2 in UTC.
    await withSimClock("2026-06-30T13:00:00Z", async () => tick());

    assert.deepEqual(calls.filter((call) => call.orgId === org.orgId), [
      { orgId: org.orgId, effectiveFrom: "2026-07-01" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    resetOverheadPublishRetryForTest();
    await dropScratchOrg(org.orgId);
  }
});

test("publish backoff retries next tick, then 1h/2h/4h, capped at 8h (C-55)", async () => {
  const { overheadPublishAttemptDue, overheadPublishRetryDelayMs } = await import("./overhead-scheduler.ts");
  const hour = 3_600_000;
  assert.equal(overheadPublishRetryDelayMs(1), 0);
  assert.equal(overheadPublishRetryDelayMs(2), hour);
  assert.equal(overheadPublishRetryDelayMs(3), 2 * hour);
  assert.equal(overheadPublishRetryDelayMs(4), 4 * hour);
  assert.equal(overheadPublishRetryDelayMs(5), 8 * hour);
  assert.equal(overheadPublishRetryDelayMs(99), 8 * hour);
  const now = Date.now();
  assert.equal(overheadPublishAttemptDue(undefined, now), true);
  assert.equal(overheadPublishAttemptDue({ consecutiveFailures: 1, nextAttemptAtMs: now }, now), true);
  assert.equal(overheadPublishAttemptDue({ consecutiveFailures: 2, nextAttemptAtMs: now + hour }, now), false);
  assert.equal(overheadPublishAttemptDue({ consecutiveFailures: 2, nextAttemptAtMs: now + hour }, now + hour), true);
});
