import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../../platform/db.ts";
import { withSimClock } from "../../platform/clock.ts";
import {
  createUsageMeter,
  deactivateUsageMeter,
  ingestUsageRecords,
  listUsageRecordsForWindow,
  reverseUsageRecord,
  updateUsageMeter,
} from "./records.ts";
import { UsageBillingError } from "./errors.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function withUsageOrg(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Usage controller", "admin"));
    await withOrgContext(org.orgId, async () => {
      const enabled = await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             settings,
             '{features}',
             coalesce(settings->'features', '{}'::jsonb)
               || '{"subscriptionBilling":true,"usageBilling":true}'::jsonb,
             true
           )
         where id = ${org.orgId}`);
      assert.equal(enabled.rowCount, 1, "the scratch organization must receive the usage feature settings");
    });
    await withOrgContext(org.orgId, () => run(org, actor));
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

function event(org: ScratchOrg, meterKey: string, idempotencyKey = randomUUID()) {
  return {
    meterKey,
    customerId: org.customerId,
    occurredOn: org.date,
    quantity: "2.5",
    source: "api" as const,
    idempotencyKey,
  };
}

test("replaying a usage idempotency key returns the same evidence row", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await createUsageMeter(org.orgId, actor, {
      key: `requests-${randomUUID()}`,
      name: "API requests",
      unit: "request",
      aggregation: "sum",
    });
    const input = event(org, meter.key);
    const [first] = await ingestUsageRecords(org.orgId, actor, [input]);
    const [replay] = await ingestUsageRecords(org.orgId, actor, [input]);
    assert.ok(first);
    assert.ok(replay);
    assert.equal(replay.id, first.id);
    assert.equal((await listUsageRecordsForWindow(org.orgId, meter.id, org.customerId, org.date, org.date)).length, 1);
  });
});

test("a reversal appends negative evidence and leaves the original unchanged", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await createUsageMeter(org.orgId, actor, {
      key: `reversals-${randomUUID()}`,
      name: "Storage units",
      unit: "GB-day",
      aggregation: "sum",
    });
    const [original] = await ingestUsageRecords(org.orgId, actor, [event(org, meter.key)]);
    assert.ok(original);
    const reversal = await withSimClock("2026-07-16", () =>
      reverseUsageRecord(org.orgId, actor, original.id, "Duplicate source event"),
    );
    assert.equal(reversal.occurredOn, "2026-07-16");
    const rows = await listUsageRecordsForWindow(org.orgId, meter.id, org.customerId, org.date, reversal.occurredOn);
    const stillOriginal = rows.find((row) => row.id === original.id);
    assert.deepEqual(stillOriginal, original);
    assert.equal(rows.length, 2);
    assert.equal(reversal.reversesId, original.id);
    assert.equal(reversal.quantity, "-2.50000000");
    assert.equal(reversal.reversalReason, "Duplicate source event");
  });
});

test("a closed AR period refuses usage and names the open-period remedy", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await createUsageMeter(org.orgId, actor, {
      key: `closed-${randomUUID()}`,
      name: "Closed period units",
      unit: "event",
      aggregation: "sum",
    });
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, reason)
        values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'ar', 'closed', now(), 'Controller close')`);
    });
    await assert.rejects(
      ingestUsageRecords(org.orgId, actor, [event(org, meter.key)]),
      (error: unknown) =>
        error instanceof UsageBillingError &&
        error.code === "usage_period_closed" &&
        error.message.includes("closed AR period") &&
        error.remedy.includes("open AR period"),
    );
  });
});

test("inactive meters and locked meter identity refusals name their remedies", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await createUsageMeter(org.orgId, actor, {
      key: `locked-${randomUUID()}`,
      name: "Concurrent jobs",
      unit: "job",
      aggregation: "sum",
    });
    await ingestUsageRecords(org.orgId, actor, [event(org, meter.key)]);
    await assert.rejects(
      updateUsageMeter(org.orgId, actor, meter.id, { key: `${meter.key}-changed` }),
      (error: unknown) =>
        error instanceof UsageBillingError &&
        error.code === "usage_meter_identity_locked" &&
        error.message.includes("cannot change after usage evidence exists") &&
        error.remedy.includes("Create a new meter and deactivate this one"),
    );

    await deactivateUsageMeter(org.orgId, actor, meter.id);
    await assert.rejects(
      ingestUsageRecords(org.orgId, actor, [event(org, meter.key)]),
      (error: unknown) =>
        error instanceof UsageBillingError &&
        error.code === "usage_meter_inactive" &&
        error.message.includes("inactive") &&
        error.remedy.includes("Reactivate the meter or send usage to its replacement"),
    );
  });
});

test("unique_count meters refuse usage without a distinct key", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await createUsageMeter(org.orgId, actor, {
      key: `unique-${randomUUID()}`,
      name: "Active users",
      unit: "user",
      aggregation: "unique_count",
    });
    await assert.rejects(
      ingestUsageRecords(org.orgId, actor, [event(org, meter.key)]),
      (error: unknown) =>
        error instanceof UsageBillingError &&
        error.code === "usage_distinct_key_required" &&
        error.message.includes("unique_count meter requires a distinct_key") &&
        error.remedy.includes("Provide the end-user or entity identifier in distinct_key"),
    );
  });
});
