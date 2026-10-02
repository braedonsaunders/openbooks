import { seedPayrollSettings } from '../testing/fixtures.ts';
import { seedPayrollComponent } from '../testing/fixtures.ts';
import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson, seedPayrollTime, seedPayrollProfile, seedPayrollWage,
  createScratchOrg, dropScratchOrg, seedFlowActors,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A rehire holds two employments, and the 0250 overlap guard keys on
 * coalesce(employment_id, employee_party_id) — so a stale still-active row
 * under the OLD employment and the current row under the NEW one do not
 * collide. The stub must still pay only its own employment's row: matching
 * on the party alone sums both into one stub, a double pay.
 */
test("a stale assignment under a prior employment is not paid twice", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await seedPayrollSettings(org.orgId, {
      features: { payroll: true },
    });
  await seedPayrollComponents(org.orgId, actorId, "CA");
  // The ON hire calculates, so its EHT leg needs the rate (never asserted here).
  await seedOntarioEhtFixture(org.orgId, actorId);

  const employeeId = randomUUID();
  const scheduleId = randomUUID();
  const oldEmploymentId = randomUUID();
  const newEmploymentId = randomUUID();
  await seedPayrollPerson(org.orgId, employeeId, 'Rehire Employee');
  await seedPayrollEmployeeRole(org.orgId, employeeId, { id: randomUUID(), terminatedOn: null });
  for (const employmentId of [oldEmploymentId, newEmploymentId]) {
    await db.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id,
                                      created_by, updated_by)
      values (${employmentId}, ${org.orgId}, ${employeeId}, ${org.subsidiaryId},
              ${actorId}, ${actorId})`);
  }
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: 'Rehire Schedule', frequency: 'biweekly', periodsPerYear: 26, anchorPeriodEnd: '2026-07-18',
    payDateOffsetDays: 3,
  });
  await seedPayrollWage(org.orgId, employeeId, actorId, {
    currency: 'CAD', rate: '30', basis: 'hour', annualHours: '2080', effectiveFrom: '2026-01-01',
  });
  // One profile per party: it follows the CURRENT employment.
  await seedPayrollProfile(org.orgId, employeeId, newEmploymentId, scheduleId, actorId, {
    country: 'CA', province: 'ON', payBasis: 'hourly', federalClaimCode: 1, provincialClaimCode: 1,
  }, { percentFloor: null, method: 'accrue' });

  await seedPayrollTime(org.orgId, employeeId, actorId, {
    workedOn: '2026-07-06', hours: '8', status: 'approved', isBillable: false, billingStatus: 'unbilled',
    costingBasis: 'actual',
  });

  const componentId = randomUUID();
  await seedPayrollComponent(org.orgId, componentId, {
    code: 'REHIRE-ALLOW', name: 'REHIRE-ALLOW', kind: 'earning', systemKey: null, basis: 'fixed_amount',
    isActive: true, createdBy: actorId, updatedBy: actorId,
  });
  // The stale row under the old employment was never closed; the current row
  // under the new employment covers the same window. Both are active.
  for (const employmentId of [oldEmploymentId, newEmploymentId]) {
    await db.execute(sql`
      insert into employee_pay_components (org_id, employee_party_id, employment_id, component_id,
                                           value, effective_from, effective_to, is_active,
                                           created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${employmentId}, ${componentId}, '100.00',
              '2026-01-01', null, true, ${actorId}, ${actorId})`);
  }

  const run = await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

  const lines = (await db.execute<{ amount: string }>(sql`
    select l.amount::text as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
     where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
       and l.component_id = ${componentId}
  `)).rows;
  assert.equal(lines.length, 1, "one employment's row is paid once, not once per employment");
  assert.equal(lines[0]!.amount, "100.0000");

  await dropScratchOrg(org.orgId);
});
