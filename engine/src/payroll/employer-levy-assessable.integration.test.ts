import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture, seedVacationTerms } from "./filing-test-fixtures.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Employer levies assess their own earnings base, never gross pay.
 *
 * Wages 1,000.00 plus a 70.00 non-taxable meal per-diem, a 5.00 taxable
 * group-life premium (non-cash), and a 90.00 non-taxable health premium:
 * the assessable base is 1,005.00, so at a 1.32% WCB class rate the premium
 * is 13.27 and at 1.95% EHT the levy is 19.60. A component excluded from
 * one levy only (the retiring-allowance shape) stays assessable for the
 * other.
 */
test(
  "employer levies assess assessable earnings: excluded components price nothing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
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
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const wcbPayable = await account("2330", "WSIB payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      const benefitClearing = await account("1200", "Benefit clearing", "asset_current_other");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "CA");
      // No annual exemption in this fixture so the levy prices the whole
      // assessable base, exactly as the synthetic states it.
      await seedOntarioEhtFixture(org.orgId, actorId, "0");
      await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", wcbPayable);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      const wcbGroupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${wcbGroupId}, ${org.orgId}, 'CLASS-A', 'Construction class A', '1.32', '100000', true)`);
      const execGroupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${execGroupId}, ${org.orgId}, 'CLASS-EXEC', 'Executive class', '0.20', '100000', true)`);

      const component = async (
        code: string,
        value: string,
        taxable: boolean,
        exclusions: string[],
        paymentKind = "cash",
      ) => {
        const id = randomUUID();
        const exclusionList = exclusions.length === 0
          ? sql`'{}'::text[]`
          : sql`ARRAY[${sql.join(exclusions.map((key) => sql`${key}`), sql`, `)}]`;
        await db.execute(sql`
          insert into pay_components (id, org_id, code, name, kind, country, basis, value, taxable,
                                      pensionable, insurable, vacationable, payment_kind,
                                      non_cash_account_id, program_exclusions, sequence,
                                      created_by, updated_by)
          values (${id}, ${org.orgId}, ${code}, ${code}, 'earning', 'CA', 'fixed_amount', ${value},
                  ${taxable}, true, true, false, ${paymentKind},
                  ${paymentKind === "non_cash" ? benefitClearing : null},
                  ${exclusionList}, 50, ${actorId}, ${actorId})`);
        return id;
      };
      const mealId = await component("MEAL", "70", false, ["wcb", "eht", "hsf", "cnt"]);
      const glifeId = await component("GLIFE", "5", true, [], "non_cash");
      const healthId = await component("HEALTH", "90", false, ["wcb", "eht", "hsf", "cnt"]);
      const vehicleId = await component("VEHICLE", "25", true, []);

      const hire = async (
        name: string,
        annualSalary: string,
        groupId: string,
        assignments: { componentId: string; value: string }[],
      ) => {
        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into employee_roles (id, org_id, party_id, worker_comp_group_id)
          values (${randomUUID()}, ${org.orgId}, ${employeeId}, ${groupId})`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                        is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, 'CAD', ${annualSalary}, 'year', '2026-01-01', true,
                  ${actorId}, ${actorId})`);
        const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                                 country, province, pay_basis, federal_claim_code,
                                                 provincial_claim_code, is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1,
                  true, ${actorId}, ${actorId})`);
        for (const assignment of assignments) {
          await db.execute(sql`
            insert into employee_pay_components (org_id, employee_party_id, employment_id, component_id,
                                                 value, effective_from, is_active, created_by, updated_by)
            values (${org.orgId}, ${employeeId}, ${employmentId}, ${assignment.componentId},
                    ${assignment.value}, '2026-01-01', true, ${actorId}, ${actorId})`);
        }
        await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");
        return employeeId;
      };

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      const workerId = await hire("Robin Crew", "26000", wcbGroupId, [
        { componentId: mealId, value: "70" },
        { componentId: glifeId, value: "5" },
        { componentId: healthId, value: "90" },
      ]);
      const execId = await hire("Avery Executive", "78000", execGroupId, [
        { componentId: vehicleId, value: "25" },
      ]);

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.deepEqual(result.errors, [], `calculation refused: ${JSON.stringify(result.errors)}`);
      assert.equal(result.employees, 2);

      const stubs = (await db.execute<{ employee_party_id: string; factors: Record<string, string> }>(sql`
        select employee_party_id, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `));
      const stubFor = (employeeId: string) =>
        stubs.rows.find((row) => row.employee_party_id === employeeId)!;

      // 1,000.00 wages + 5.00 taxable group-life: the 70.00 per-diem and the
      // 90.00 health premium are excluded from both levies.
      const workerFactors = stubFor(workerId).factors;
      assert.equal(workerFactors.WCB_EARN, "1005.0000");
      assert.equal(workerFactors.WCB, "13.2700");
      assert.equal(workerFactors.EHT_EARN, "1005.0000");
      assert.equal(workerFactors.EHT, "19.6000");

      // Executive class: 3,000.00 salary + 25.00 taxable vehicle benefit
      // assessable at 0.20% prices 3,025.00 x 0.002 = 6.05.
      const execFactors = stubFor(execId).factors;
      assert.equal(execFactors.WCB_EARN, "3025.0000");
      assert.equal(execFactors.WCB, "6.0500");

      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `));
      assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
      assert.equal(sum(glLines.rows.filter((row) => row.account_id === wcbPayable).map((row) => row.amount)), "-19.3200");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
