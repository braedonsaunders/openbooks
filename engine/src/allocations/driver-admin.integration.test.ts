import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../test-fixtures.ts";
import {
  DriverAdminError,
  createDriver,
  createDriverValue,
  deleteDriver,
  deleteDriverValue,
  getDriver,
  listDriverValues,
  listDrivers,
  updateDriver,
  updateDriverValue,
} from "./driver-admin.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("driver CRUD round trip with audit + slug conflict", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const created = await createDriver(org.orgId, actorId, {
      key: "fte-headcount",
      name: "Headcount FTE",
      unit: "FTE",
      dimension: "department",
      sourceKind: "manual",
    });
    assert.equal(created.key, "fte-headcount");
    assert.equal(created.isActive, true);

    await assert.rejects(
      () => createDriver(org.orgId, actorId, {
        key: "fte-headcount",
        name: "Duplicate",
        dimension: "department",
        sourceKind: "manual",
      }),
      (error: unknown) => error instanceof DriverAdminError && error.code === "conflict",
    );

    const listed = await listDrivers(org.orgId);
    assert.ok(listed.some((d) => d.id === created.id));

    const updated = await updateDriver(org.orgId, actorId, created.id, { name: "Headcount FTE v2" });
    assert.equal(updated.name, "Headcount FTE v2");

    const audits = await db.execute<{ action: string }>(sql`
      select action from audit_log
       where org_id = ${org.orgId} and table_name = 'allocation_drivers' and row_id = ${created.id}
       order by at`);
    assert.deepEqual(audits.rows.map((r) => r.action), ["insert", "update"]);

    await deleteDriver(org.orgId, actorId, created.id);
    assert.equal(await getDriver(org.orgId, created.id), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("driver delete is refused while a rule version references it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const driver = await createDriver(org.orgId, actorId, {
      key: "ref-driver",
      name: "Referenced",
      dimension: "department",
      sourceKind: "manual",
    });
    const ruleId = randomUUID();
    await db.execute(sql`
      insert into allocation_rules (id, org_id, key, name, mode, created_by, updated_by)
      values (${ruleId}, ${org.orgId}, 'ref-rule', 'Ref rule', 'period', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into allocation_rule_versions (org_id, rule_id, version_no, effective_from, driver_id, basis_kind, created_by, updated_by)
      values (${org.orgId}, ${ruleId}, 1, '2026-01-01', ${driver.id}, 'driver', ${actorId}, ${actorId})`);
    await assert.rejects(() => deleteDriver(org.orgId, actorId, driver.id),
      (error: unknown) => error instanceof DriverAdminError && error.code === "referenced");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("gl_activity driver refuses cross-org accounts", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await assert.rejects(
      () => createDriver(org.orgId, actorId, {
        key: "xorg",
        name: "Cross org",
        dimension: "department",
        sourceKind: "gl_activity",
        config: { accountScope: { kind: "accounts", accountIds: [other.accounts.revenue] } },
      }),
      (error: unknown) => error instanceof DriverAdminError && error.code === "validation",
    );
    const ok = await createDriver(org.orgId, actorId, {
      key: "ok-scope",
      name: "Scoped",
      dimension: "department",
      sourceKind: "gl_activity",
      config: { accountScope: { kind: "accounts", accountIds: [org.accounts.revenue] } },
    });
    assert.equal(ok.sourceKind, "gl_activity");
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});

test("manual values: exact decimals, overlap guard, end-dating, onDate read", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const driver = await createDriver(org.orgId, actorId, {
      key: "manual-fte",
      name: "Manual FTE",
      dimension: "subsidiary",
      sourceKind: "manual",
    });
    const v1 = await createDriverValue(org.orgId, actorId, driver.id, {
      dimensionValueId: org.subsidiaryId,
      effectiveFrom: "2026-01-01",
      value: "12.5",
    });
    assert.equal(v1.value, "12.5000");

    await assert.rejects(
      () => createDriverValue(org.orgId, actorId, driver.id, {
        dimensionValueId: org.subsidiaryId,
        effectiveFrom: "2026-06-01",
        value: "3",
      }),
      (error: unknown) => error instanceof DriverAdminError && error.code === "conflict",
    );
    await assert.rejects(
      () => createDriverValue(org.orgId, actorId, driver.id, {
        dimensionValueId: org.subsidiaryId,
        effectiveFrom: "2026-07-01",
        value: "-2",
      }),
      (error: unknown) => error instanceof DriverAdminError && error.code === "validation",
    );

    // End-date the first row, then the second window fits.
    const ended = await updateDriverValue(org.orgId, actorId, v1.id, { effectiveTo: "2026-05-31" });
    assert.equal(ended.effectiveTo, "2026-05-31");
    const v2 = await createDriverValue(org.orgId, actorId, driver.id, {
      dimensionValueId: org.subsidiaryId,
      effectiveFrom: "2026-06-01",
      value: "3",
    });
    assert.equal(v2.value, "3.0000");

    const jan = await listDriverValues(org.orgId, driver.id, { onDate: "2026-03-15" });
    assert.deepEqual(jan.map((v) => v.value), ["12.5000"]);
    const jul = await listDriverValues(org.orgId, driver.id, { onDate: "2026-07-01" });
    assert.deepEqual(jul.map((v) => v.value), ["3.0000"]);

    // effectiveFrom is immutable: the unique key is (driver, value, from).
    await deleteDriverValue(org.orgId, actorId, v1.id);
    await deleteDriverValue(org.orgId, actorId, v2.id);
    assert.deepEqual(await listDriverValues(org.orgId, driver.id), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("revision tokens round-trip; stale tokens refused", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const driver = await createDriver(org.orgId, actorId, {
      key: "stale-driver",
      name: "Stale",
      dimension: "department",
      sourceKind: "manual",
    });
    assert.ok(driver.updatedAt, "create returns the canonical revision token");
    const renamed = await updateDriver(org.orgId, actorId, driver.id, {
      name: "Fresh",
      expectedUpdatedAt: driver.updatedAt ?? undefined,
    });
    assert.equal(renamed.name, "Fresh");
    await assert.rejects(
      () => updateDriver(org.orgId, actorId, driver.id, {
        name: "Stale edit",
        expectedUpdatedAt: driver.updatedAt ?? undefined,
      }),
      (error: unknown) => error instanceof DriverAdminError && error.code === "stale",
    );
    await assert.rejects(
      () => updateDriver(org.orgId, actorId, driver.id, {
        name: "Stale edit",
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }),
      (error: unknown) => error instanceof DriverAdminError && error.code === "stale",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
