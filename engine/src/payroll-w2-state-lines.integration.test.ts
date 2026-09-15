import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { setPackSlotAccount } from "./payroll/packs.ts";
import { yearEndFiling } from "./payroll-filing-registry.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The W-2 reports federal boxes 1–6 only. State income tax IS withheld on US
 * stubs (California below), but no state wage or withholding line exists on
 * the slip — so a state-withholding stub has money no box reports. That gap
 * must be declared on the filing, never implied away: the slip note used to
 * claim "state lines are reported per state of employment" while no such
 * lines exist anywhere in the W-2, W-2c, or population.
 */
test(
  "a state-withholding stub is disclosed as unreported on the W-2, not implied as reported",
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
      const irsPayable = await account("2330", "Federal payroll taxes payable", "liability_current");
      const statePayable = await account("2360", "State income tax payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            wagesTo: "expense",
            countries: ["US"],
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "US");
      for (const slot of ["fit", "fica", "futa", "suta"]) {
        await setPackSlotAccount(org.orgId, actorId, "US", slot, irsPayable);
      }
      await setPackSlotAccount(org.orgId, actorId, "US", "state_income_tax", statePayable);

      const subsidiaryId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
                '{}'::jsonb, false, true, '{}'::jsonb)`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, subsidiary_id, is_active,
                                   created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, '2026-07-18', 3,
                ${subsidiaryId}, true, ${actorId}, ${actorId})`);
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Sam Worker', ${subsidiaryId}, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${employeeId})`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'USD', '52000', 'year', 2080, '2026-01-01', true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                               province, pay_basis, filing_status,
                                               is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'US', 'CA',
                'salary', 'single', true, ${actorId}, ${actorId})`);

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      assert.deepEqual((await calculatePayRun({
        orgId: org.orgId, documentId: run.documentId, actorId,
      })).errors, []);
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

      // The stub really does withhold state tax: without this line the rest of
      // the test would pass vacuously.
      const stateLines = (await db.execute<{ amount: string }>(sql`
        select l.amount::text as amount
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
          join pay_components c on c.id = l.component_id and c.org_id = l.org_id
         where l.org_id = ${org.orgId} and r.run_status = 'committed'
           and c.system_key = 'state_income_tax'`));
      assert.equal(stateLines.rows.length, 1);
      assert.ok(Number(stateLines.rows[0]!.amount) > 0, "California tax is withheld on the stub");

      // No state wage or withholding box exists on the slip: boxes are 1–6.
      const filing = yearEndFiling("US", "w2");
      const population = await filing.population(org.orgId, 2026);
      assert.equal(population.rows.length, 1);
      const slip = await filing.slip!.build(org.orgId, 2026, population.rows[0]!.rowId as string);
      assert.deepEqual(slip.boxes.map((box) => box.code), ["1", "2", "3", "4", "5", "6"]);

      // And the filing says so: the gap is declared, and the slip note no
      // longer claims state lines are reported.
      const { W2_GAPS } = await import("./payroll/us/filings.ts");
      assert.ok(
        W2_GAPS.some((gap) => /state/i.test(gap)),
        "the US pack declares the missing W-2 state boxes as a gap",
      );
      assert.ok(
        slip.notes!.some((note) => /state/i.test(note) && /not/i.test(note)),
        "the W-2 slip discloses that state lines are not reported",
      );
      assert.ok(
        !slip.notes!.some((note) => /state lines are reported per state/i.test(note)),
        "the W-2 slip no longer claims state lines are reported",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
