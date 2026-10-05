import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";
import { setPackSlotAccount } from "./packs.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Department expense mapping: the same earning posts to different
 * expense accounts by worker department.
 *
 * Regular Wages defaults to 5110 with an Overhead → 8010 override. A run
 * with 1,000.00 of Field hours and 400.00 of Overhead hours posts
 * DR 5110 1,000.00 and DR 8010 400.00; the liability side and the
 * balancing total are unchanged.
 */
test(
  "department mappings override the component expense account per line",
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
      const wagesDefault = await account("5110", "Regular wages", "expense");
      const overheadExpense = await account("8010", "Overhead wages", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wagesDefault,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId, "0");
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);
      // Regular Wages defaults to 5110 at the component.
      const baseId = (await db.execute<{ id: string }>(sql`
        select id from pay_components
         where org_id = ${org.orgId} and code = 'BASE' and country is null
      `)).rows[0]!.id;
      await db.execute(sql`
        update pay_components set expense_account_id = ${wagesDefault}, updated_by = ${actorId}
         where org_id = ${org.orgId} and id = ${baseId}`);

      const department = async (code: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into departments (id, org_id, code, name, is_active)
          values (${id}, ${org.orgId}, ${code}, ${code}, true)`);
        return id;
      };
      const fieldId = await department("FIELD");
      const overheadId = await department("OVERHEAD");
      await db.execute(sql`
        insert into pay_component_department_expenses
               (org_id, pay_component_id, department_id, expense_account_id,
                effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${baseId}, ${overheadId}, ${overheadExpense},
                '2026-01-01', true, ${actorId}, ${actorId})`);

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Weekly', 'weekly', 52, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Dana Department', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${employeeId})`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '25', 'hour', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                               country, province, pay_basis, federal_claim_code,
                                               provincial_claim_code, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                true, ${actorId}, ${actorId})`);
      const { seedVacationTerms } = await import("./filing-test-fixtures.ts");
      await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");
      // 40 Field hours (1,000.00) and 16 Overhead hours (400.00), no items.
      for (const [departmentId, hours] of [[fieldId, "40"], [overheadId, "16"]] as const) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, department_id, status,
                                    is_billable, billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, '2026-07-14', ${hours}, ${departmentId}, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-12", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.deepEqual(result.errors, []);

      // The stub carries one line per department, each stamped at calculate.
      const stubLines = (await db.execute<{
        amount: string; department_id: string | null;
        expense_account_id: string | null; expense_account_source: string | null;
      }>(sql`
        select l.amount, l.department_id, l.expense_account_id, l.expense_account_source
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
         where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
           and l.kind = 'earning'
      `));
      assert.equal(stubLines.rows.length, 2);
      const fieldLine = stubLines.rows.find((row) => row.department_id === fieldId)!;
      const overheadLine = stubLines.rows.find((row) => row.department_id === overheadId)!;
      assert.equal(fieldLine.amount, "1000.0000");
      assert.equal(fieldLine.expense_account_id, wagesDefault);
      assert.equal(fieldLine.expense_account_source, "component");
      assert.equal(overheadLine.amount, "400.0000");
      assert.equal(overheadLine.expense_account_id, overheadExpense);
      assert.equal(overheadLine.expense_account_source, "department");

      // The range exclusion is the backstop: an overlapping active window
      // for the same component and department refuses at the database,
      // even for writers around the setup validation hook.
      await assert.rejects(
        db.execute(sql`
          insert into pay_component_department_expenses
                 (org_id, pay_component_id, department_id, expense_account_id,
                  effective_from, is_active, created_by, updated_by)
          values (${org.orgId}, ${baseId}, ${overheadId}, ${wagesDefault},
                  '2026-06-01', true, ${actorId}, ${actorId})`),
        (error: unknown) => {
          const cause = (error as { cause?: { code?: string } })?.cause;
          assert.equal(cause?.code, "23P01");
          return true;
        },
      );

      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `));
      assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
      assert.equal(
        sum(glLines.rows.filter((row) => row.account_id === wagesDefault).map((row) => row.amount)),
        "1000.0000",
      );
      assert.equal(
        sum(glLines.rows.filter((row) => row.account_id === overheadExpense).map((row) => row.amount)),
        "400.0000",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
