import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, neg, sum } from "../money/money.ts";
import { AU_PACK_RATES } from "./au/rates.ts";
import { setPackSlotAccount } from "./packs.ts";
import { payrollStatutoryRateGaps } from "./readiness.ts";
import { upsertStatutoryRate } from "./statutory-rates.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * AU workers' compensation: a configured regional premium rate must accrue.
 *
 * Observed shape: readiness warned "no Workers' compensation premium is
 * configured for NSW / VIC / QLD — nothing is being accrued", the operator
 * saved NSW 0.012 / VIC 0.014 / QLD 0.011 through the rates surface, the
 * warning cleared — and the committed, posted run carried zero WCB lines on
 * every stub, in the journal, and in employer cost. The ledger still
 * balanced, because nothing was ever pushed.
 *
 * Each employee works 80h × $30 = $2,400 gross, so the regional premiums are:
 * NSW 2400 × 0.012 = 28.80, VIC 2400 × 0.014 = 33.60, QLD 2400 × 0.011 = 26.40.
 */
test(
  "AU WCB: configured regional rates accrue per region and leave net pay untouched",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await db.execute(sql`
        insert into currencies (code, name, minor_units)
        values ('AUD', 'Australian Dollar', 2)
        on conflict (code) do nothing`);
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
      const paygPayable = await account("2310", "PAYG withholding payable", "liability_current");
      const superPayable = await account("2320", "Superannuation payable", "liability_current");
      const wcbPayable = await account("2330", "Workers compensation payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          features: { payroll: true },
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            wagesTo: "expense",
            countries: ["AU"],
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "AU");
      await setPackSlotAccount(org.orgId, actorId, "AU", "payg", paygPayable);
      await setPackSlotAccount(org.orgId, actorId, "AU", "super", superPayable);
      await setPackSlotAccount(org.orgId, actorId, "AU", "wcb", wcbPayable);

      const auSubId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${auSubId}, ${org.orgId}, ${org.subsidiaryId}, 'AU Entity', 'AUD', 'AU',
                '{}'::jsonb, false, true, '{}'::jsonb)`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, subsidiary_id, is_active,
                                   created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Fortnightly AU', 'biweekly', 26, '2026-07-18', 3,
                ${auSubId}, true, ${actorId}, ${actorId})`);

      const seedEmployee = async (name: string, province: string) => {
        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', ${name}, ${auSubId}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                        is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, 'AUD', '30', 'hour', '2026-07-01', true, ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                                 province, pay_basis, vacation_percent,
                                                 vacation_method, is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${scheduleId}, 'AU', ${province}, 'hourly', '0',
                  'accrue', true, ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into employee_tax_certificates (id, org_id, employee_party_id, country, certificate_key,
                                                 answers, created_by, updated_by)
          values (${randomUUID()}, ${org.orgId}, ${employeeId}, 'AU', 'au_tfn_declaration',
                  ${JSON.stringify({
                    tax_file_number: "123456782",
                    residency: "australian_resident",
                    working_holiday_maker: "false",
                    tax_free_threshold: "true",
                    stsl_debt: "false",
                  })}::jsonb, ${actorId}, ${actorId})`);
        for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
          await db.execute(sql`
            insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                      billing_status, costing_basis, created_by, updated_by)
            values (${org.orgId}, ${employeeId}, ${workedOn}, 20, 'approved', false,
                    'unbilled', 'actual', ${actorId}, ${actorId})`);
        }
        return employeeId;
      };
      const nswEmployeeId = await seedEmployee("Sydney Worker", "NSW");
      const vicEmployeeId = await seedEmployee("Melbourne Worker", "VIC");
      const qldEmployeeId = await seedEmployee("Brisbane Worker", "QLD");

      // The warning the operator saw first: configured nowhere, warned everywhere.
      const gapsBefore = await payrollStatutoryRateGaps(org.orgId, "AU", 2027);
      const wcbGapsBefore = gapsBefore.filter((gap) => gap.slotKey === "au_workers_comp");
      assert.equal(wcbGapsBefore.length, 3, "NSW, VIC and QLD each warn before configuration");
      for (const gap of wcbGapsBefore) {
        assert.match(gap.message, /nothing is being accrued/);
      }

      // The operator's saves, through the same write boundary the UI uses.
      await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: AU_PACK_RATES, rateKey: "au_workers_comp",
        region: "NSW", filingAccountId: null, taxYear: 2027, values: { rate: "0.012" },
      });
      await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: AU_PACK_RATES, rateKey: "au_workers_comp",
        region: "VIC", filingAccountId: null, taxYear: 2027, values: { rate: "0.014" },
      });
      await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: AU_PACK_RATES, rateKey: "au_workers_comp",
        region: "QLD", filingAccountId: null, taxYear: 2027, values: { rate: "0.011" },
      });

      // The warning clears once every touched region resolves — honest only
      // if the run below actually accrues.
      const gapsAfter = await payrollStatutoryRateGaps(org.orgId, "AU", 2027);
      assert.ok(
        !gapsAfter.some((gap) => gap.slotKey === "au_workers_comp"),
        "no WCB gap remains once all three regions resolve",
      );

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.equal(result.employees, 3);
      assert.deepEqual(result.errors, []);

      const expected: Record<string, string> = {
        [nswEmployeeId]: "28.8000",
        [vicEmployeeId]: "33.6000",
        [qldEmployeeId]: "26.4000",
      };
      for (const [employeeId, amount] of Object.entries(expected)) {
        const lines = (await db.execute<{
          system_key: string | null; kind: string; description: string; amount: string; sequence: number;
        }>(sql`
          select c.system_key, l.kind, l.description, l.amount, l.sequence
            from pay_stub_lines l
            join pay_components c on c.id = l.component_id
            join pay_stubs s on s.id = l.stub_id
           where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
             and s.employee_party_id = ${employeeId} and c.system_key = 'wcb'`));
        assert.equal(lines.rows.length, 1, "one WCB line on the stub");
        assert.deepEqual(
          [lines.rows[0]!.sequence, lines.rows[0]!.kind, lines.rows[0]!.description],
          [260, "employer_contribution", "Workers' compensation"],
        );
        assert.equal(lines.rows[0]!.amount, amount);
      }

      // Employer-side only: net pay is gross less withholdings, so the new
      // accrual must not move any stub's net.
      const stubs = (await db.execute<{
        employee_party_id: string; gross: string; net_pay: string; employer_cost: string;
      }>(sql`
        select employee_party_id, gross, net_pay, employer_cost from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}`));
      assert.equal(stubs.rows.length, 3);
      for (const stub of stubs.rows) {
        assert.equal(stub.gross, "2400.0000");
        const deductions = (await db.execute<{ total: string }>(sql`
          select coalesce(sum(l.amount), 0)::text as total
            from pay_stub_lines l
            join pay_stubs s on s.id = l.stub_id
           where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
             and s.employee_party_id = ${stub.employee_party_id} and l.kind = 'deduction'`));
        assert.equal(
          stub.net_pay,
          sum([stub.gross, neg(deductions.rows[0]!.total)]),
          "net is gross less withholdings — the WCB accrual does not touch it",
        );
        assert.equal(
          stub.employer_cost,
          sum(["288.0000", expected[stub.employee_party_id]!]),
          "employer cost carries SG plus the regional WCB premium",
        );
      }

      // Through commit into the journal: the premium lands on the mapped
      // liability and the projection still balances.
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}`));
      assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
      const wcbLegs = glLines.rows.filter((row) => row.account_id === wcbPayable);
      assert.equal(sum(wcbLegs.map((row) => row.amount)), neg("88.8000"));
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
