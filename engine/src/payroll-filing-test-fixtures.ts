import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  calculatePayRun,
  createPayRun,
  seedPayrollComponents,
} from "./payroll-run.ts";
import { createScratchOrg, seedFlowActors } from "./test-fixtures.ts";

export interface AdoptionFixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  employeeId: string;
  employeeName: string;
}

async function seedEmployee(
  fx: { orgId: string; actorId: string; scheduleId: string },
  options: { name: string; hiredOn?: string } = { name: "Terry Worker" },
): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${fx.orgId}, 'person', ${options.name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${options.hiredOn ?? "2020-01-06"}, true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2020-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${fx.scheduleId}, 'ON', 'hourly', 'CA', 1, 1,
            '4', 'accrue', true, ${fx.actorId}, ${fx.actorId})`);
  return employeeId;
}

/** A Canadian org with payroll accounts, components, a schedule and one hire. */
export async function seedAdoption(
  options: { hiredOn?: string } = {},
): Promise<AdoptionFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
    values(${org.orgId},${actorId},'payroll.manage','grant')`);

  const account = async (number: string, name: string, type: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                            reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  const wageExpense = await account("6000", "Wages expense", "expense");
  const burdenExpense = await account("6010", "Payroll burden", "expense");
  const netPayable = await account(
    "2300",
    "Wages payable",
    "liability_current_other",
  );
  const craPayable = await account(
    "2310",
    "CRA remittances payable",
    "liability_current_other",
  );
  const vacationPayable = await account(
    "2320",
    "Vacation payable",
    "liability_current_other",
  );
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        cppPayableAccountId: craPayable,
        eiPayableAccountId: craPayable,
        taxPayableAccountId: craPayable,
        vacationPayableAccountId: vacationPayable,
        wagesTo: "expense",
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);

  const employeeName = "Terry Worker";
  const employeeId = await seedEmployee(
    { orgId: org.orgId, actorId, scheduleId },
    { name: employeeName, hiredOn: options.hiredOn },
  );

  return {
    orgId: org.orgId,
    actorId,
    subsidiaryId: org.subsidiaryId,
    scheduleId,
    employeeId,
    employeeName,
  };
}

export async function calculatedRun(fx: AdoptionFixture) {
  const entry = (
    await db.execute<{ id: string }>(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
      is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${fx.employeeId}, '2026-07-14', 8, 'approved', false,
      'unbilled', 'actual', ${fx.actorId}, ${fx.actorId}) returning id
  `)
  ).rows[0]!;
  const run = await createPayRun({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: fx.scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  const input = {
    orgId: fx.orgId,
    actorId: fx.actorId,
    documentId: run.documentId,
  };
  assert.deepEqual((await calculatePayRun(input)).errors, []);
  return { input, entryId: entry.id };
}

/** Model rows that predate 0093. DDL and row changes are one transaction;
 * the guard is restored before commit. Production reconciliation never disables it. */
export async function markLegacy(orgId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`alter table pay_stubs disable trigger pay_stub_filing_account_guard`,
    );
    const rows = await tx.execute<{
      id: string;
    }>(sql`update pay_stubs set filing_account_id=null,
      filing_account_source='unknown',filing_account_evidence=null where org_id=${orgId} returning id`);
    await tx.execute(
      sql`alter table pay_stubs enable trigger pay_stub_filing_account_guard`,
    );
    return rows.rows[0]!.id;
  });
}
