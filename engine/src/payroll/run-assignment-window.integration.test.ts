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
 * An assignment ending mid-period still applies to the period: readiness
 * treats the window as overlapping the period, and the stub must agree.
 * (The stub used to require effective_to >= period_end, so the assignment
 * passed pre-flight and was then silently left off the cheque.)
 */
test("an assignment ending mid-period is paid on the stub", { skip: !DB }, async () => {
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
    values (${employeeId}, ${org.orgId}, 'person', 'Window Employee', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, terminated_on)
    values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`);
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Window Schedule', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2080', '2026-01-01', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_percent, vacation_method, is_active,
                                           created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
            null, 'accrue', true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                              is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, '2026-07-06', '8', 'approved',
            false, 'unbilled', 'actual', ${actorId}, ${actorId})`);

  const component = async (code: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                  created_by, updated_by)
      values (${id}, ${org.orgId}, ${code}, ${code}, 'earning', null, 'fixed_amount',
              true, ${actorId}, ${actorId})`);
    return id;
  };
  const midId = await component("MIDSUM");
  const beforeId = await component("BEFORESUM");
  const assign = async (componentId: string, from: string, to: string | null): Promise<void> => {
    await db.execute(sql`
      insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                           effective_from, effective_to, is_active,
                                           created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${componentId}, '50.00', ${from}, ${to}, true,
              ${actorId}, ${actorId})`);
  };
  // Ends mid-period (period is 2026-07-05–18): must be paid.
  await assign(midId, "2026-01-01", "2026-07-10");
  // Ended the day before the period started: must stay off.
  await assign(beforeId, "2026-01-01", "2026-07-04");

  const run = await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

  const lines = (await db.execute<{ code: string; amount: string }>(sql`
    select c.code, l.amount::text as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
       and l.component_id in (${midId}, ${beforeId})
  `)).rows;
  const byCode = new Map(lines.map((l) => [l.code, l.amount]));
  assert.equal(byCode.get("MIDSUM"), "50.0000",
    "an assignment ending mid-period is part of the period and must be paid");
  assert.ok(!byCode.has("BEFORESUM"),
    "an assignment that ended before the period started must stay off the stub");

  await dropScratchOrg(org.orgId);
});
