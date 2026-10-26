import { seedPayrollAccountingConfiguration } from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPackSlotAccount } from "./packs.ts";
import { payRunReadiness } from "./readiness.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture, seedVacationTerms } from "./filing-test-fixtures.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Workers-compensation coverage is decided per employee, never by the
 * absence of a value: a missing rate class with no recorded exemption
 * silently accrued no premium. Three salaried office employees on one
 * Alberta-schedule run (the 1.84% class from the field report): one covered,
 * one undecided, one exempt as an uncovered owner. Readiness names the
 * undecided employee before calculate with both remedies; calculate refuses
 * them by name while the other two stubs land; recording the exemption (or
 * the class) clears the refusal with no premium priced.
 */
test(
  "undecided workers-compensation coverage is refused by name, exempt is not",
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
      const wcbPayable = await account("2330", "WCB payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await seedPayrollAccountingConfiguration(org.orgId, {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        slotAccounts: {
          CA: { cpp: craPayable, ei: craPayable, qpip: craPayable, income_tax: craPayable },
        },
      });

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId, "0");
      await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", wcbPayable);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      const groupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${groupId}, ${org.orgId}, 'OFFICE-184', 'Office class', '1.84', '100000', true)`);

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2025-10-24', 3, true,
                ${actorId}, ${actorId})`);

      const hire = async (
        name: string,
        withGroup: boolean,
        exempt: { exempt: boolean; reason: string | null },
      ) => {
        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into employee_roles (id, org_id, party_id, worker_comp_group_id)
          values (${randomUUID()}, ${org.orgId}, ${employeeId}, ${withGroup ? groupId : null})`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                        is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, 'CAD', '26000', 'year', '2025-01-01', true,
                  ${actorId}, ${actorId})`);
        const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                                 country, province, pay_basis, federal_claim_code,
                                                 provincial_claim_code, wcb_exempt, wcb_exempt_reason,
                                                 is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'AB', 'salary', 1, 1,
                  ${exempt.exempt}, ${exempt.reason}, true, ${actorId}, ${actorId})`);
        await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");
        return employeeId;
      };
      const coveredId = await hire("Cara Covered", true, { exempt: false, reason: null });
      const undecidedId = await hire("Uli Undecided", false, { exempt: false, reason: null });
      const exemptId = await hire("Erin Exempt", false, {
        exempt: true,
        reason: "owner not covered by the employer account",
      });

      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: "2025-10-11",
        periodEnd: "2025-10-24",
      });

      // Before calculate: one blocker naming only the undecided employee,
      // with both remedies and the link to the payroll tab.
      const readiness = await payRunReadiness(org.orgId, run.documentId);
      const coverage = readiness.items.filter((item) => item.code === "employee.noWorkerComp");
      assert.equal(
        coverage.length,
        1,
        `one coverage blocker, got ${JSON.stringify(readiness.items.map((i) => i.code))}`,
      );
      assert.equal(coverage[0]!.severity, "blocker");
      assert.deepEqual(
        coverage[0]!.employees.map((e) => e.name),
        ["Uli Undecided"],
      );
      assert.match(coverage[0]!.detail ?? "", /rate class/);
      assert.match(coverage[0]!.detail ?? "", /exempt/);
      assert.equal(coverage[0]!.href, "/entities/employees");

      // Calculate: the undecided employee is refused by name; the other two
      // stubs land with the covered one priced and the exempt one premium-free.
      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      const refusals = result.errors.filter((e) => e.kind === "refusal");
      assert.equal(refusals.length, 1, `one refusal, got ${JSON.stringify(result.errors)}`);
      assert.equal(refusals[0]!.employee, "Uli Undecided");
      assert.match(refusals[0]!.message, /workers-compensation coverage/);
      assert.match(refusals[0]!.message, /Payroll tab/);
      assert.equal(result.employees, 2);

      const stubs = await db.execute<{
        employee_party_id: string;
        factors: Record<string, string>;
      }>(
        sql`
        select employee_party_id, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `,
        "objects",
      );
      const stubFor = (employeeId: string) =>
        stubs.find((row) => row.employee_party_id === employeeId);
      assert.ok(stubFor(coveredId), "the covered employee has a stub");
      assert.equal(stubFor(coveredId)!.factors.WCB_EARN, "1000.0000");
      assert.equal(stubFor(coveredId)!.factors.WCB, "18.4000");
      assert.ok(stubFor(exemptId), "the exempt employee has a stub");
      assert.ok(
        !("WCB" in (stubFor(exemptId)!.factors ?? {})),
        "the exempt employee accrues no premium",
      );
      assert.equal(stubFor(undecidedId), undefined, "a refused employee leaves no partial stub");

      // The remedy clears it: recording the exemption prices no premium and
      // refuses nothing.
      await db.execute(sql`
        update employee_payroll_profiles set wcb_exempt = true,
          wcb_exempt_reason = 'owner not covered by the employer account'
         where org_id = ${org.orgId} and employee_party_id = ${undecidedId}`);
      const retry = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(
        retry.errors,
        [],
        `remedied calculation refused: ${JSON.stringify(retry.errors)}`,
      );
      assert.equal(retry.employees, 3);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
