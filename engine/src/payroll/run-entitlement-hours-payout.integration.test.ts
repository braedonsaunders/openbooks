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
 * A 40-hour bank at $30/h pays $1,200 on the final cheque — not $40.00. The
 * payout line pays the bank's MONEY value (hours valued at the current wage);
 * the ledger movement clearing the bank stays in the plan's unit.
 */
test("a final pay values an hours bank at the wage", { skip: !DB }, async () => {
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
    values (${employeeId}, ${org.orgId}, 'person', 'Banked Employee', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, terminated_on)
    values (${randomUUID()}, ${org.orgId}, ${employeeId}, '2026-07-18')`);
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Bank Schedule', 'biweekly', 26, '2026-07-18', 3, true,
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

  const payoutComponentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                created_by, updated_by)
    values (${payoutComponentId}, ${org.orgId}, 'SICK-PAY', 'Sick bank payout', 'earning', null,
            'fixed_amount', true, ${actorId}, ${actorId})`);
  const planId = randomUUID();
  await db.execute(sql`
    insert into entitlement_plans (id, org_id, code, name, system_key, unit, direction,
                                   accrual_method, payout_component_id, created_by, updated_by)
    values (${planId}, ${org.orgId}, 'SICK-HRS', 'Sick bank', null, 'hours', 'accrue',
            'manual', ${payoutComponentId}, ${actorId}, ${actorId})`);
  // 40 banked hours, accrued before this run.
  await db.execute(sql`
    insert into entitlement_ledger (org_id, plan_id, employee_party_id, movement_date, amount,
                                    hours, kind, pay_run_document_id, note, created_by, updated_by)
    values (${org.orgId}, ${planId}, ${employeeId}, '2026-07-01', '40.0000',
            null, 'accrual', null, 'banked time', ${actorId}, ${actorId})`);

  const run = await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
    runType: "termination",
    employeePartyIds: [employeeId],
  });
  await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

  const lines = (await db.execute<{ amount: string }>(sql`
    select l.amount::text as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
     where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
       and l.component_id = ${payoutComponentId}
  `)).rows;
  assert.equal(lines.length, 1, "the final pay carries the bank payout line");
  assert.equal(lines[0]!.amount, "1200.0000",
    "40 hours at $30/h pay $1,200 — never the $40.00 hour count");

  // The clearing movement stays in the plan's unit: the bank IS hours.
  const cleared = (await db.execute<{ amount: string; kind: string }>(sql`
    select amount::text as amount, kind from entitlement_ledger
     where org_id = ${org.orgId} and plan_id = ${planId} and kind = 'payout'
  `)).rows;
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.amount, "-40.0000");

  await dropScratchOrg(org.orgId);
});
