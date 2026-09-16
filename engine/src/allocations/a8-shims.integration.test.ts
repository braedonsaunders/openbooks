import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../test-fixtures.ts";
import { EnginePendingError, getDimensionValueLabels, previewManualDriverVector } from "./a8-shims.ts";
import { createDriver, createDriverValue } from "./driver-admin.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("manual driver preview resolves the effective vector", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const driver = await createDriver(org.orgId, actorId, {
      key: "prev-manual",
      name: "Preview manual",
      dimension: "subsidiary",
      sourceKind: "manual",
    });
    await createDriverValue(org.orgId, actorId, driver.id, {
      dimensionValueId: org.subsidiaryId,
      effectiveFrom: "2026-01-01",
      value: "7.25",
    });
    const { vector, date } = await previewManualDriverVector(org.orgId, driver.id, { date: "2026-04-01" });
    assert.equal(date, "2026-04-01");
    assert.deepEqual([...vector.entries()], [[org.subsidiaryId, "7.2500"]]);

    const before = await previewManualDriverVector(org.orgId, driver.id, { date: "2025-12-31" });
    assert.equal(before.vector.size, 0);

    const excluded = await previewManualDriverVector(org.orgId, driver.id, { date: "2026-04-01" }, {
      exclude: [org.subsidiaryId],
    });
    assert.equal(excluded.vector.size, 0);

    const labels = await getDimensionValueLabels(org.orgId, "subsidiary", [org.subsidiaryId]);
    assert.equal(labels.size, 1);
    assert.ok((labels.get(org.subsidiaryId) ?? "").length > 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("manual preview accepts a period as-of (period end date)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const driver = await createDriver(org.orgId, actorId, {
      key: "prev-period",
      name: "Preview period",
      dimension: "subsidiary",
      sourceKind: "manual",
    });
    await createDriverValue(org.orgId, actorId, driver.id, {
      dimensionValueId: org.subsidiaryId,
      effectiveFrom: "2026-01-01",
      value: "1",
    });
    const period = await db.execute<{ ends_on: string }>(
      (await import("drizzle-orm")).sql`select ends_on::text from accounting_periods where id = ${org.periodId}`,
    );
    const { vector, date } = await previewManualDriverVector(org.orgId, driver.id, { periodId: org.periodId });
    assert.equal(date, String(period.rows[0]?.ends_on).slice(0, 10));
    assert.equal(vector.size, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("non-manual drivers are pending on A2", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const driver = await createDriver(org.orgId, actorId, {
      key: "prev-gl",
      name: "Preview GL",
      dimension: "department",
      sourceKind: "gl_activity",
      config: { accountScope: { kind: "any" } },
    });
    await assert.rejects(
      () => previewManualDriverVector(org.orgId, driver.id, { date: "2026-04-01" }),
      (error: unknown) => error instanceof EnginePendingError && error.ownerShard === "A2",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
