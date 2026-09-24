import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { PayRunAdjustmentIdempotencyConflict, mutatePayRunAdjustment, payRunBulkAdjustmentId } from "./run-adjustments.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function payrollFixture(label: string) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");
  const employeeId = randomUUID();
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', ${`${label} Employee`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values
      (${scheduleId}, ${org.orgId}, ${`${label} Schedule`}, 'biweekly', 26, '2026-07-18',
       3, true, ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
       federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
    values
      (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true,
       ${actorId}, ${actorId})
  `);
  const run = await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  const component = (await db.execute<{ id: string }>(sql`
    select id from pay_components where org_id = ${org.orgId} and code = 'BONUS'
  `));
  return {
    orgId: org.orgId,
    actorId,
    employeeId,
    documentId: run.documentId,
    componentId: component.rows[0]!.id,
  };
}

const adjustmentCount = async (orgId: string, documentId: string): Promise<number> => {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from pay_run_adjustments
     where org_id = ${orgId} and pay_run_document_id = ${documentId} and adjustment_type = 'line'
  `)).rows;
  return Number(rows[0]!.n);
};

/**
 * A replayed add (double-clicked Save, retried request) carries the form
 * session's key, which becomes the adjustment row id: the second request
 * returns the original result instead of a second adjustment.
 */
test("replaying an adjustment add with the same key writes once", { skip: !DB }, async () => {
  const fx = await payrollFixture("IdemSingle");
  try {
    const key = randomUUID();
    const mutation = {
      action: "add" as const,
      employeePartyId: fx.employeeId,
      componentId: fx.componentId,
      amount: "125.00",
      note: "Approved one-off",
      idempotencyKey: key,
    };
    const first = await mutatePayRunAdjustment({
      orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId, mutation,
    });
    assert.equal(first.changed, true);
    assert.equal(first.replayed, false);
    const second = await mutatePayRunAdjustment({
      orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId, mutation,
    });
    assert.equal(second.changed, false);
    assert.equal(second.replayed, true);
    assert.equal(await adjustmentCount(fx.orgId, fx.documentId), 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("the same key with different details is refused, never replayed", { skip: !DB }, async () => {
  const fx = await payrollFixture("IdemConflict");
  try {
    const key = randomUUID();
    await mutatePayRunAdjustment({
      orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId,
      mutation: {
        action: "add", employeePartyId: fx.employeeId, componentId: fx.componentId,
        amount: "125.00", idempotencyKey: key,
      },
    });
    await assert.rejects(
      mutatePayRunAdjustment({
        orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId,
        mutation: {
          action: "add", employeePartyId: fx.employeeId, componentId: fx.componentId,
          amount: "999.00", idempotencyKey: key,
        },
      }),
      PayRunAdjustmentIdempotencyConflict,
    );
    assert.equal(await adjustmentCount(fx.orgId, fx.documentId), 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("a replayed bulk batch writes each row once", { skip: !DB }, async () => {
  const fx = await payrollFixture("IdemBulk");
  try {
    const batchKey = randomUUID();
    const rowId = payRunBulkAdjustmentId(batchKey, fx.employeeId);
    assert.ok(isUuid(rowId), "expected a real UUID row id");
    const apply = () => mutatePayRunAdjustment({
      orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId,
      mutation: {
        action: "add", employeePartyId: fx.employeeId, componentId: fx.componentId,
        amount: "50.00", idempotencyKey: rowId,
      },
    });
    await apply();
    const replay = await apply();
    assert.equal(replay.replayed, true);
    assert.equal(await adjustmentCount(fx.orgId, fx.documentId), 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("adds without a key keep legacy generated ids", { skip: !DB }, async () => {
  const fx = await payrollFixture("IdemLegacy");
  try {
    const mutation = {
      action: "add" as const,
      employeePartyId: fx.employeeId,
      componentId: fx.componentId,
      amount: "10.00",
    };
    await mutatePayRunAdjustment({ orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId, mutation });
    await mutatePayRunAdjustment({ orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId, mutation });
    assert.equal(await adjustmentCount(fx.orgId, fx.documentId), 2);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
