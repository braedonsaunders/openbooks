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
  const fullId = await component("FULLSUM");
  const assign = async (componentId: string, value: string, from: string, to: string | null): Promise<void> => {
    await db.execute(sql`
      insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                           effective_from, effective_to, is_active,
                                           created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${componentId}, ${value}, ${from}, ${to}, true,
              ${actorId}, ${actorId})`);
  };
  // Ends mid-period (period is 2026-07-05–18): paid for the 6 covered days.
  await assign(midId, "50.00", "2026-01-01", "2026-07-10");
  // Ended the day before the period started: must stay off.
  await assign(beforeId, "50.00", "2026-01-01", "2026-07-04");
  // Covers the whole period: paid in full, byte-identical to unwindowed.
  await assign(fullId, "50.00", "2026-01-01", null);

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
       and l.component_id in (${midId}, ${beforeId}, ${fullId})
  `)).rows;
  const byCode = new Map(lines.map((l) => [l.code, l.amount]));
  // 6 of the 14 period days covered: 6/14 × 50.00, rounded to cents.
  assert.equal(byCode.get("MIDSUM"), "21.4300",
    "an assignment ending mid-period is paid for its covered days, not the full period");
  assert.ok(!byCode.has("BEFORESUM"),
    "an assignment that ended before the period started must stay off the stub");
  assert.equal(byCode.get("FULLSUM"), "50.0000",
    "a fully-covering assignment pays its full value with no proration math");

  await dropScratchOrg(org.orgId);
});

/**
 * A mid-period amendment is stored as two adjacent rows — old ending the
 * 15th, new starting the 16th — which the overlap guard allows. Each slice
 * pays its covered calendar-day fraction, so the two slices of one amended
 * component sum to exactly one period: never the sum of both full values.
 */
test("a mid-month amendment pays each slice, never twice the component", { skip: !DB }, async () => {
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
    values (${employeeId}, ${org.orgId}, 'person', 'Amend Employee', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, terminated_on)
    values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`);
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Amend Schedule', 'monthly', 12, '2026-07-31', 3, true,
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

  const componentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                created_by, updated_by)
    values (${componentId}, ${org.orgId}, 'AMENDED-ALLOW', 'AMENDED-ALLOW', 'earning', null,
            'fixed_amount', true, ${actorId}, ${actorId})`);
  const slice = async (value: string, from: string, to: string | null): Promise<void> => {
    await db.execute(sql`
      insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                           effective_from, effective_to, is_active,
                                           created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${componentId}, ${value}, ${from}, ${to}, true,
              ${actorId}, ${actorId})`);
  };
  await slice("3000.00", "2026-01-01", "2026-07-15");
  await slice("3100.00", "2026-07-16", null);

  const run = await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
  });
  await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

  const lines = (await db.execute<{ amount: string }>(sql`
    select l.amount::text as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
     where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
       and l.component_id = ${componentId}
     order by l.amount
  `)).rows;
  assert.equal(lines.length, 2, "both slices of the amended component are paid");
  // 15/31 × 3000.00 and 16/31 × 3100.00, rounded to cents: ≈ half each.
  assert.equal(lines[0]!.amount, "1451.6100");
  assert.equal(lines[1]!.amount, "1600.0000");
  assert.ok(Number(lines[0]!.amount) + Number(lines[1]!.amount) < 6100,
    "the two slices must never sum to both full values");

  await dropScratchOrg(org.orgId);
});
