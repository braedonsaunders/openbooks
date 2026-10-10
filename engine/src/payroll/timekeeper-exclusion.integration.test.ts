import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { seedAdoption } from "./filing-test-fixtures.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";

/**
 * Payroll admits only employments. A partner's approved billable hours sit
 * in time_entries beside an employee's, but the run builds from the
 * employment roster and its time reads scope to each run employee — the
 * partner's entries stay unclaimed for every run in the period.
 */
test("a pay run never claims a non-employee timekeeper's approved hours", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedAdoption();
  try {
    const partner = randomUUID();
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values (${partner},${fx.orgId},'person','Service partner',${fx.subsidiaryId},true,'{}'::jsonb)`);
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
        is_billable, billing_status, costing_basis, created_by, updated_by)
      values (${fx.orgId}, ${partner}, '2026-07-14', 6, 'approved', true,
        'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
    const run = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId,
      payScheduleId: fx.scheduleId, periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    const calculated = await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
    assert.deepEqual(calculated.errors, []);
    const claims = (await db.execute<{ id: string; batch: string | null }>(sql`
      select id, payroll_batch_ref as batch from time_entries
       where org_id=${fx.orgId} and employee_party_id=${partner}`)).rows;
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.batch, null, "partner hours stay unclaimed: no employment, no stub");
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});
