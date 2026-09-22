import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

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
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");

  const employeeId = randomUUID();
  const scheduleId = randomUUID();
  const oldEmploymentId = randomUUID();
  const newEmploymentId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Rehire Employee', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, terminated_on)
    values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`);
  for (const employmentId of [oldEmploymentId, newEmploymentId]) {
    await db.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id,
                                      created_by, updated_by)
      values (${employmentId}, ${org.orgId}, ${employeeId}, ${org.subsidiaryId},
              ${actorId}, ${actorId})`);
  }
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Rehire Schedule', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2080', '2026-01-01', true,
            ${actorId}, ${actorId})`);
  // One profile per party: it follows the CURRENT employment.
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                           country, province, pay_basis, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${newEmploymentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
            null, 'accrue', true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                              is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, '2026-07-06', '8', 'approved',
            false, 'unbilled', 'actual', ${actorId}, ${actorId})`);

  const componentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                created_by, updated_by)
    values (${componentId}, ${org.orgId}, 'REHIRE-ALLOW', 'REHIRE-ALLOW', 'earning', null,
            'fixed_amount', true, ${actorId}, ${actorId})`);
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
