import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, neg, sum } from "./money.ts";
import { calculateT4127 } from "./payroll/canada/t4127.ts";
import { calculateTp1015 } from "./payroll/canada/quebec/tp1015.ts";
import { setPackSlotAccount } from "./payroll/packs.ts";
import { yearEndFiling } from "./payroll-filing-registry.ts";
import { rl1Population } from "./payroll-rl1.ts";
import { payrollRemittanceSummary } from "./payroll-remittance.ts";
import { calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { t4Slips } from "./payroll-yearend.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Quebec end to end: the province the CA pack used to REFUSE, now calculated
 * by both engines together — T4127 for the federal side (abatement, QPP,
 * QPIP) and TP-1015 for Québec provincial income tax — with the QC liability
 * posted to its own account, QPP/QPIP remitted to the REVENU QUÉBEC vendor
 * (never the CRA's), and the RL-1 population fed from the same stubs while
 * T4 box 22 stays federal-only.
 */
test(
  "QC pay run end to end: TP-1015 beside T4127, RQ remittance routing, RL-1 population",
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
      const qcPayable = await account("2315", "Revenu Québec payable", "liability_current");
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");

      // A second vendor party: Revenu Québec. org.vendorId plays the CRA.
      const rqVendorId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${rqVendorId}, ${org.orgId}, 'company', 'Revenu Québec', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${org.orgId}, ${rqVendorId}, true, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${org.orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
        on conflict do nothing`);

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
            craRemittancePartyId: org.vendorId,
            // The pack's regional declaration routes a QC stub's QPP/QPP2/QPIP
            // here (TPZ-1015.R), never to the CRA vendor above.
            rqRemittancePartyId: rqVendorId,
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "CA");
      // The QC slot gets its own liability account so the projection credits
      // the Québec withholding separately from the CRA payable.
      await setPackSlotAccount(org.orgId, actorId, "CA", "qc_income_tax", qcPayable);
      // Québec income tax is declared `external`: the org names its Revenu
      // Québec vendor on the component itself.
      await db.execute(sql`
        update pay_components set remittance_party_id = ${rqVendorId}
         where org_id = ${org.orgId} and system_key = 'qc_income_tax'`);

      // QC employee: hourly, biweekly, TP-1015.3-V default credits (no claim
      // code — Québec has none).
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Jean Tremblay', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                               pay_basis, federal_claim_code, vacation_percent,
                                               vacation_method, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'QC', 'hourly', 1,
                '0', 'accrue', true, ${actorId}, ${actorId})`);

      for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                    billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${workedOn}, 20, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.equal(result.employees, 1);
      assert.deepEqual(result.errors, []);

      const stubs = (await db.execute(sql`
        select * from pay_stubs where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: Record<string, string>[] };
      assert.equal(stubs.rows.length, 1);
      const stub = stubs.rows[0]!;
      assert.equal(stub.gross, "2400.0000"); // 80h × $30

      // Both engines called directly with the same facts (pay date 2026-07-21).
      const federal = calculateT4127({
        payDate: "2026-07-21", province: "QC", periodsPerYear: 26,
        income: "2400.00", federalClaimCode: 1,
      });
      const quebec = calculateTp1015({
        payDate: "2026-07-21", periodsPerYear: 26,
        income: "2400.00", qpp: federal.cpp, qpp2: federal.cpp2, pensionable: "2400.00",
      });

      // The stub carries BOTH factor sets: T4127's and the QC_ prefixed trace.
      const factors = stub.factors as unknown as Record<string, string>;
      assert.equal(factors.C, federal.cpp, "QPP under the T4127 C factor");
      assert.equal(factors.QPIP, federal.qpip);
      assert.ok(factors.QC_A !== undefined, "TP-1015 trace factors are on the stub");
      assert.ok(factors.QC_Y !== undefined);

      // Lines: QPP (system key cpp), EI at the QC rate, QPIP — and Québec
      // income tax as its OWN component beside the federal income tax.
      const stubLines = (await db.execute(sql`
        select c.system_key, c.code, l.kind, l.description, l.amount, l.sequence
          from pay_stub_lines l
          join pay_components c on c.id = l.component_id
         where l.org_id = ${org.orgId} and l.stub_id = ${stub.id}
         order by l.sequence
      `)) as unknown as {
        rows: { system_key: string | null; code: string; kind: string; description: string; amount: string; sequence: number }[];
      };
      const line = (systemKey: string, kind: string) =>
        stubLines.rows.find((row) => row.system_key === systemKey && row.kind === kind);

      const qcTax = line("qc_income_tax", "deduction");
      assert.ok(qcTax, "Québec income tax is its own stub line");
      assert.equal(qcTax!.amount, quebec.totalTax);
      assert.equal(qcTax!.sequence, 115);
      assert.equal(line("income_tax", "deduction")!.amount, federal.totalTax);
      assert.equal(line("cpp", "deduction")!.description, "QPP");
      assert.equal(line("cpp", "deduction")!.amount, federal.cpp);
      assert.equal(line("ei", "deduction")!.amount, federal.ei);
      const qpip = line("qpip", "deduction");
      assert.ok(qpip && cmp(qpip.amount, "0") > 0, "QPIP is withheld for QC employment");
      assert.equal(qpip!.amount, federal.qpip);
      assert.ok(line("qpip", "employer_contribution"), "employer QPIP accrues");

      const deductions = sum([
        federal.totalTax, quebec.totalTax, federal.cpp, federal.cpp2, federal.ei, federal.qpip,
      ]);
      assert.equal(stub.net_pay, add("2400.0000", neg(deductions)));

      // Commit: the GL credits the Québec liability SEPARATELY from the CRA
      // payable, from the component's own slot account.
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = (await db.execute(sql`
        select account_id, amount from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `)) as unknown as { rows: { account_id: string; amount: string }[] };
      assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
      const qcLegs = glLines.rows.filter((row) => row.account_id === qcPayable);
      assert.equal(qcLegs.length, 1, "one credit leg on the Québec liability account");
      assert.equal(qcLegs[0]!.amount, neg(quebec.totalTax));

      // Remittance: the pack's regional declaration sends QPP/QPIP (both
      // shares) and the external QCTAX to the Revenu Québec vendor; the CRA
      // vendor keeps federal income tax and EI only. This is the misroute the
      // Quebec handoff flagged, fixed and held here.
      const groups = await payrollRemittanceSummary(org.orgId, { from: "2026-07-01", to: "2026-07-31" });
      const rqGroup = groups.find((group) => group.partyId === rqVendorId);
      const craGroup = groups.find((group) => group.partyId === org.vendorId);
      assert.ok(rqGroup, "a Revenu Québec remittance group exists");
      assert.ok(craGroup, "a CRA remittance group exists");
      const keys = (group: typeof rqGroup) =>
        [...new Set(group!.components.map((component) => component.systemKey))].sort();
      assert.deepEqual(keys(rqGroup), ["cpp", "qc_income_tax", "qpip"],
        "QPP, QPIP and Québec tax remit to Revenu Québec");
      assert.deepEqual(keys(craGroup), ["ei", "income_tax"],
        "the CRA keeps federal income tax and EI — never a QC employee's QPP/QPIP");
      assert.equal(rqGroup!.total, sum([
        federal.cpp, federal.cppEmployer, federal.qpip, federal.qpipEmployer, quebec.totalTax,
      ]));

      // Year-end: the RL-1 is a declared CA filing and its population carries
      // the committed QC stub; T4 box 22 stays FEDERAL-only by construction.
      const rl1 = yearEndFiling("CA", "rl1");
      assert.equal(rl1.label, "RL-1 slips (Revenu Québec)");
      const population = await rl1Population(org.orgId, 2026);
      assert.equal(population.rows.length, 1);
      assert.equal(population.rows[0]!.boxE, quebec.totalTax);
      const slips = await t4Slips(org.orgId, 2026);
      assert.equal(slips.length, 1);
      assert.equal(slips[0]!.isQuebec, true);
      assert.equal(slips[0]!.box22IncomeTax, federal.totalTax,
        "T4 box 22 is the federal tax alone — qc_income_tax is a different system key");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
