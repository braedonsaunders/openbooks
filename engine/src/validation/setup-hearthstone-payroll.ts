/** One-shot: finish payroll setup for the Hearthstone sim tenant (dev DB). */
import { randomBytes, scryptSync, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { seedPayrollComponents, createPayRun, calculatePayRun } from "../payroll-run.ts";

const ORG = "9c484d30-6e69-489d-af9b-59e44aa59f82";
const ACTOR = "53ad1d00-457e-4460-adc0-ca5ec9b84734"; // Sam Admin

const one = async (q: any): Promise<any> => ((await db.execute(q)) as any).rows[0];

// 1. Feature flag + a vacation-payable account + settings.payroll
await db.execute(sql`
  update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,payroll}', 'true'::jsonb)
  where id = ${ORG}`);

const acct = async (number: string, name: string, type: string): Promise<string> => {
  const existing = await one(sql`select id from accounts where org_id = ${ORG} and number = ${number}`);
  if (existing) return existing.id;
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${ORG}, ${number}, ${name}, ${type}, false, true, false, false,
            '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
};
const byNumber = async (n: string) => (await one(sql`select id from accounts where org_id=${ORG} and number=${n}`)).id;

const wageExpense = await byNumber("6000");        // Salaries & Wages
const burdenExpense = await byNumber("6020");      // Payroll Tax Expense
const netPay = await byNumber("2120");             // Accrued Payroll
const craPayable = await byNumber("2260");         // Payroll Taxes Payable
const vacationPayable = await acct("2270", "Vacation Payable", "liability_current_other");

await db.execute(sql`
  update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll}', ${JSON.stringify({
    wageExpenseAccountId: wageExpense,
    burdenExpenseAccountId: burdenExpense,
    netPayAccountId: netPay,
    cppPayableAccountId: craPayable,
    eiPayableAccountId: craPayable,
    taxPayableAccountId: craPayable,
    vacationPayableAccountId: vacationPayable,
    wagesTo: "expense",
    craRemittancePartyId: null,
    countries: ["CA"],
  })}::jsonb)
  where id = ${ORG}`);

// 2. Canada pack components
await seedPayrollComponents(ORG, ACTOR);

// 3. Pay schedule (biweekly, anchored so 2026-06-28..07-11 is a period)
let schedule = await one(sql`select id from pay_schedules where org_id = ${ORG} and name = 'Biweekly'`);
if (!schedule) {
  schedule = await one(sql`
    insert into pay_schedules (org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_default, is_active, created_by, updated_by)
    values (${ORG}, 'Biweekly', 'biweekly', 26, '2026-07-11', 3, true, true, ${ACTOR}, ${ACTOR})
    returning id`);
}

// 4. Wages + payroll profiles for the four employees
const employees: [string, string][] = [
  ["fe8fc150-e4f0-44b5-89ef-f599a6e16217", "52"], // Renee Walsh, Portfolio Manager
  ["afb16db3-35e8-4bc4-bb0d-150987832ab0", "44"], // Omar Khalil, Property Manager
  ["a50bfe2b-1178-4fbb-9bf2-87f2949d58bf", "39"], // Grace Liu, Leasing Manager
  ["cdea6eb3-9f62-4829-9674-e9eb9cd5b1b4", "33"], // Derek Cole, Building Coordinator
];
for (const [partyId, wage] of employees) {
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    select ${ORG}, ${partyId}, 'USD', ${wage}, 'hour', '2026-01-01', true, ${ACTOR}, ${ACTOR}
    where not exists (select 1 from labor_cost_rates
                       where org_id = ${ORG} and employee_party_id = ${partyId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_percent, vacation_method, is_active,
                                           created_by, updated_by)
    values (${ORG}, ${partyId}, ${schedule.id}, 'ON', 'hourly', 1, 1, '4', 'accrue', true,
            ${ACTOR}, ${ACTOR})
    on conflict (org_id, employee_party_id) do update set pay_schedule_id = ${schedule.id}`);
}

// 5. Pay run over a period with approved sim time, calculated and ready to review
const hours = await one(sql`
  select count(*) n, coalesce(sum(hours), 0) h from time_entries
   where org_id = ${ORG} and status = 'approved'
     and worked_on between '2026-06-28' and '2026-07-11'`);
console.log(`period time: ${hours.n} entries, ${hours.h} hours`);
const existingRun = await one(sql`
  select document_id from pay_runs where org_id = ${ORG} and period_end = '2026-07-11'`);
const documentId = existingRun?.document_id ??
  (await createPayRun({ orgId: ORG, actorId: ACTOR, payScheduleId: schedule.id,
    periodStart: "2026-06-28", periodEnd: "2026-07-11" })).documentId;
const result = await calculatePayRun({ orgId: ORG, documentId, actorId: ACTOR });
console.log(`pay run ${documentId}: ${result.employees} stubs`, result.errors);

// 6. Review login
const password = "hearthstone-review";
const salt = randomBytes(16);
const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
const adminRole = await one(sql`select id, permissions from app_roles where org_id = ${ORG} and key = 'admin'`);
const user = await db.transaction(async (tx) => {
  await tx.execute(sql`set constraints all deferred`);
  const u = ((await tx.execute(sql`
    insert into users (org_id, email, name, password_hash, is_active)
    values (${ORG}, 'braedon@hearthstone.test', 'Braedon Review', ${hash}, true)
    on conflict (org_id, email) do update set password_hash = ${hash}, is_active = true
    returning id`)) as any).rows[0];
  await tx.execute(sql`
    insert into role_assignments (org_id, user_id, role_id)
    values (${ORG}, ${u.id}, ${adminRole.id})
    on conflict do nothing`);
  return u;
});
console.log(`login: braedon@hearthstone.test / ${password} (admin role has ${JSON.parse(JSON.stringify(adminRole.permissions)).length ?? "?"} permissions)`);
process.exit(0);
