// Consolidated DB-test file: merged from sibling per-finding suites to
// share one file's startup cost. Each describe block is one former file;
// bodies are unchanged apart from import hoisting.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { describe } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import { calculateT4127 } from "./canada/t4127.ts";
import { calculateTp1015 } from "./canada/quebec/tp1015.ts";
import { setPackSlotAccount } from "./packs.ts";
import { yearEndFiling } from "./filing-registry.ts";
import { rl1Population, rl1Slips, rl1Summary } from "./canada/quebec/rl1.ts";
import { createRemittanceBill, payrollRemittanceSummary } from "./remittance.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { t4Slips, t4Summary } from "./yearend.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from "../testing/fixtures.ts";
import { seedCntSubjectEmployerFixture, seedHiredEmployee } from "./filing-test-fixtures.ts";

describe("quebec", () => {

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
        const hsfPayable = await account("2360", "HSF payable", "liability_current");

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
        // A QC employer always owes the HSF at its own payroll-determined rate:
        // an unclassified employer refuses by name at calculate, so the
        // fixture classifies ordinary-sector (sectorOther) and carries
        // its own payable.
        await setPackSlotAccount(org.orgId, actorId, "CA", "hsf", hsfPayable);
        await db.execute(sql`
          insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                               rate_values, created_by, updated_by)
          values (${org.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"sectorOther": "true"}',
                  ${actorId}, ${actorId})`);
        // Québec income tax is declared `external`: the org names its Revenu
        // Québec vendor on the component itself.
        await db.execute(sql`
          update pay_components set remittance_party_id = ${rqVendorId}
           where org_id = ${org.orgId} and system_key = 'qc_income_tax'`);

        // The stubs price CNT too: classify the employer (asserted nowhere here).
        await seedCntSubjectEmployerFixture(org.orgId, actorId, org.subsidiaryId, craPayable);
        const scheduleId = randomUUID();
        await db.execute(sql`
          insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                     pay_date_offset_days, is_active, created_by, updated_by)
          values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                  ${actorId}, ${actorId})`);
        // QC employee: hourly, biweekly, TP-1015.3-V default credits (no claim
        // code — Québec has none).
        await seedHiredEmployee(org.orgId, actorId, {
          scheduleId, subsidiaryId: org.subsidiaryId, name: "Jean Tremblay", country: "CA",
          province: "QC", payBasis: "hourly", currency: "CAD", rate: "30", rateBasis: "hour",
          federalClaimCode: 1, vacationPercent: "0", vacationMethod: "accrue",
          timeEntries: ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]
            .map((workedOn) => ({ workedOn })),
        });

        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        assert.equal(result.employees, 1);
        assert.deepEqual(result.errors, []);

        const stubs = (await db.execute<Record<string, string>>(sql`
          select * from pay_stubs where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
        `));
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
        // The QPIP program's own base rides the stub under its declared factor:
        // no exclusions here, so it covers the same earnings as the EI leg.
        assert.equal(factors.IE_QPIP, "2400.0000");
        assert.ok(factors.QC_A !== undefined, "TP-1015 trace factors are on the stub");
        assert.ok(factors.QC_Y !== undefined);

        // Lines: QPP (system key cpp), EI at the QC rate, QPIP — and Québec
        // income tax as its OWN component beside the federal income tax.
        const stubLines = (await db.execute<{ system_key: string | null; code: string; kind: string; description: string; amount: string; sequence: number }>(sql`
          select c.system_key, c.code, l.kind, l.description, l.amount, l.sequence
            from pay_stub_lines l
            join pay_components c on c.id = l.component_id
           where l.org_id = ${org.orgId} and l.stub_id = ${stub.id}
           order by l.sequence
        `));
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

        // Statutory lines post in canonical display order: federal income tax,
        // Québec income tax, QPP, EI, QPIP, then the employer shares. (This
        // stub earns under the first CPP ceiling, so no CPP2 line posts;
        // the 130 slot is pinned by the second-tier ON test in
        // payroll-employer-taxes.) Any shift in a sort key reorders the stub.
        assert.deepEqual(
          stubLines.rows
            .filter((row) => row.sequence >= 100)
            .map((row) => [row.sequence, row.system_key, row.kind]),
          [
            [110, "income_tax", "deduction"],
            [115, "qc_income_tax", "deduction"],
            [120, "cpp", "deduction"],
            [140, "ei", "deduction"],
            [150, "qpip", "deduction"],
            [210, "cpp", "employer_contribution"],
            [220, "ei", "employer_contribution"],
            [230, "qpip", "employer_contribution"],
            [280, "hsf", "employer_contribution"],
            [285, "cnt", "employer_contribution"],
          ],
        );
        assert.equal(line("cpp", "employer_contribution")!.description, "QPP (employer)");
        // The employer's own HSF rate times the full gross, no exemption, no
        // cap: 2400.00 × 1.65% = 39.60, on its own slot account.
        assert.equal(line("hsf", "employer_contribution")!.amount, "39.6000");
        // Classified for CNT, the stub prices the labour-standards levy too:
        // 2400.00 × 0.06% = 1.44, on the CRA payable like the HSF above it.
        assert.equal(line("cnt", "employer_contribution")!.amount, "1.4400");

        const deductions = sum([
          federal.totalTax, quebec.totalTax, federal.cpp, federal.cpp2, federal.ei, federal.qpip,
        ]);
        assert.equal(stub.net_pay, add("2400.0000", neg(deductions)));

        // Commit: the GL credits the Québec liability SEPARATELY from the CRA
        // payable, from the component's own slot account.
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        const glLines = (await db.execute<{ account_id: string; amount: string }>(sql`
          select account_id, amount from document_lines
           where org_id = ${org.orgId} and document_id = ${run.documentId}
        `));
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
        assert.deepEqual(keys(rqGroup), ["cnt", "cpp", "hsf", "qc_income_tax", "qpip"],
          "QPP, QPIP, HSF, CNT and Québec tax remit to Revenu Québec");
        assert.deepEqual(keys(craGroup), ["ei", "income_tax"],
          "the CRA keeps federal income tax and EI — never a QC employee's QPP/QPIP");
        assert.equal(rqGroup!.total, sum([
          federal.cpp, federal.cppEmployer, federal.qpip, federal.qpipEmployer, quebec.totalTax,
          "39.6000", "1.4400",
        ]));

        // T4's on-screen reconciliation amount is the CRA remittance only. A
        // Québec source-deduction bill is a different authority's filing and
        // must not inflate the federal T4 summary after both bills are posted.
        for (const group of [craGroup, rqGroup]) {
          const bill = await createRemittanceBill(org.orgId, actorId, {
            partyId: group!.partyId!,
            from: "2026-07-01",
            to: "2026-07-31",
            filingAccountId: group!.filingAccount.id,
          });
          await submitAndReleaseIfUngated("vendor_bill", bill.documentId, actorId);
          await postDocument(bill.documentId, {
            control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
          });
        }
        const t4 = await t4Summary(org.orgId, 2026);
        assert.equal(cmp(t4.remitted, craGroup!.total), 0,
          "T4 remitted total includes only posted CRA bills, not Revenu Québec bills");

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
        // T4 box 56 reads the stub's program factor end to end (C-12/C-13):
        // the full gross, with no pre-adoption carry-in and under the maximum.
        assert.equal(slips[0]!.box56QpipInsurable, "2400.0000");
      } finally {
        await dropScratchOrgReporting(org.orgId);
      }
    },
  );
});

describe("quebec-hsf", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  /**
   * Québec Health Services Fund (TP-1015.F-V s. 5).
   *
   * The publication-pasted golden: the 2026 Revenu Québec table's other-sector
   * rate (1.65%) times the remuneration subject — employment income is
   * generally subject, so the stub's gross — with no cap:
   * 2400.00 × 1.65% = 39.60. The rate is derived from year-to-date payroll
   * under the classified sector (sectorOther in this fixture); unclassified
   * employers refuse instead of pricing a guessed rate.
   */
  test(
    "QC HSF: formula rate times gross on QC stubs, never on ON stubs, remitted to Revenu Québec",
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
        const hsfPayable = await account("2360", "HSF payable", "liability_current");

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
              // The pack's regional declaration routes a QC stub's HSF here
              // (TPZ-1015.R), never to the CRA vendor above.
              rqRemittancePartyId: rqVendorId,
            },
          })}::jsonb where id = ${org.orgId}`);

        await seedPayrollComponents(org.orgId, actorId, "CA");
        await setPackSlotAccount(org.orgId, actorId, "CA", "qc_income_tax", qcPayable);
        await setPackSlotAccount(org.orgId, actorId, "CA", "hsf", hsfPayable);
        await db.execute(sql`
          update pay_components set remittance_party_id = ${rqVendorId}
           where org_id = ${org.orgId} and system_key = 'qc_income_tax'`);

        // The employer's sector class for Revenu Québec's total-payroll table:
        // ordinary-sector (sectorOther), pricing 1.65% at this payroll.
        await db.execute(sql`
          insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                               rate_values, created_by, updated_by)
          values (${org.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"sectorOther": "true"}',
                  ${actorId}, ${actorId})`);
        // The ON leg needs its own explicit EHT declaration: ca_eht refuses
        // when unconfigured, and this test pins HSF gating, not EHT. Values
        // are an explicit zero, asserted nowhere here.
        await db.execute(sql`
          insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                               rate_values, created_by, updated_by)
          values (${org.orgId}, 'CA', 'ca_eht', 'ON', 2026, '{"rate": "0", "annualExemption": "0"}',
                  ${actorId}, ${actorId})`);

        const scheduleId = randomUUID();
        await db.execute(sql`
          insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                     pay_date_offset_days, is_active, created_by, updated_by)
          values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                  ${actorId}, ${actorId})`);
        // The QC stubs price CNT too: classify the employer (asserted nowhere in these tests).
        await seedCntSubjectEmployerFixture(org.orgId, actorId, org.subsidiaryId, craPayable);
        const seedEmployee = async (name: string, province: string) => {
          const { employeeId } = await seedHiredEmployee(org.orgId, actorId, {
            scheduleId, subsidiaryId: org.subsidiaryId, name, country: "CA", province,
            payBasis: "hourly", currency: "CAD", rate: "30", rateBasis: "hour",
            federalClaimCode: 1, vacationPercent: "0", vacationMethod: "accrue",
            timeEntries: ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]
              .map((workedOn) => ({ workedOn })),
          });
          return employeeId;
        };
        const qcEmployeeId = await seedEmployee("Jean Tremblay", "QC");
        const onEmployeeId = await seedEmployee("Casey Siteworker", "ON");

        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        assert.equal(result.employees, 2);
        assert.deepEqual(result.errors, []);

        const stubs = (await db.execute<{ employee_party_id: string; factors: Record<string, string> }>(sql`
          select employee_party_id, factors from pay_stubs
           where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
        `));
        assert.equal(stubs.rows.length, 2);
        const stubFor = (employeeId: string) =>
          stubs.rows.find((row) => row.employee_party_id === employeeId)!;

        // QC golden: 2400.00 × 1.65% = 39.60 on the full gross — no exemption,
        // no cap, exactly as the publication states the contribution.
        const qcFactors = stubFor(qcEmployeeId).factors;
        assert.equal(qcFactors.HSF_EARN, "2400.0000");
        assert.equal(qcFactors.HSF, "39.6000");

        const qcLines = (await db.execute<{ system_key: string | null; kind: string; description: string; amount: string; sequence: number }>(sql`
          select c.system_key, l.kind, l.description, l.amount, l.sequence
            from pay_stub_lines l
            join pay_components c on c.id = l.component_id
            join pay_stubs s on s.id = l.stub_id
           where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
             and s.employee_party_id = ${qcEmployeeId} and c.system_key = 'hsf'
        `));
        assert.equal(qcLines.rows.length, 1);
        assert.deepEqual(
          [qcLines.rows[0]!.sequence, qcLines.rows[0]!.kind, qcLines.rows[0]!.description],
          [280, "employer_contribution", "Health Services Fund"],
        );
        assert.equal(qcLines.rows[0]!.amount, "39.6000");

        // The region gate: the ON stub carries no HSF evidence at all, even
        // though the org holds a QC HSF rate.
        const onFactors = stubFor(onEmployeeId).factors;
        assert.equal(onFactors.HSF ?? "0", "0");
        assert.ok(!("HSF_EARN" in onFactors), "no HSF assessable earnings outside QC");
        const onHsfLines = (await db.execute<{ amount: string }>(sql`
          select l.amount
            from pay_stub_lines l
            join pay_components c on c.id = l.component_id
            join pay_stubs s on s.id = l.stub_id
           where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
             and s.employee_party_id = ${onEmployeeId} and c.system_key = 'hsf'
        `));
        assert.equal(onHsfLines.rows.length, 0);

        // Remittance: the pack's regional declaration sends the QC stub's HSF
        // to the Revenu Québec vendor; the CRA vendor never sees it.
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        const glLines = (await db.execute<{ account_id: string; amount: string }>(sql`
          select account_id, amount from document_lines
           where org_id = ${org.orgId} and document_id = ${run.documentId}
        `));
        assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
        const hsfLeg = glLines.rows.filter((row) => row.account_id === hsfPayable);
        assert.equal(sum(hsfLeg.map((row) => row.amount)), neg("39.6000"));

        const groups = await payrollRemittanceSummary(org.orgId, { from: "2026-07-01", to: "2026-07-31" });
        const rqGroup = groups.find((group) => group.partyId === rqVendorId);
        const craGroup = groups.find((group) => group.partyId === org.vendorId);
        assert.ok(rqGroup, "a Revenu Québec remittance group exists");
        assert.ok(craGroup, "a CRA remittance group exists");
        const rqHsf = rqGroup!.components.filter((component) => component.systemKey === "hsf");
        assert.equal(rqHsf.length, 1, "HSF remits to Revenu Québec");
        assert.equal(sum(rqHsf.map((component) => component.amount)), "39.6000");
        assert.ok(
          !craGroup!.components.some((component) => component.systemKey === "hsf"),
          "the CRA never sees a QC stub's HSF",
        );
      } finally {
        await dropScratchOrgReporting(org.orgId);
      }
    },
  );
});

describe("qpip-employer-cap", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  /**
   * Employer QPIP has its OWN annual maximum ($620.06 for 2026) — unlike EI,
   * it is not a multiple of the capped employee amount, so each period must
   * be reduced by what the employer already accrued. One $400,000 period takes
   * the whole maximum; the next period must accrue nothing. Anything more
   * over-remits every high earner's employer share for the rest of the year.
   */
  test(
    "employer QPIP accrues against its own annual maximum across periods",
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
        const rqVendorId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${rqVendorId}, ${org.orgId}, 'company', 'Revenu Québec', true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
          values (${org.orgId}, ${rqVendorId}, true, ${actorId}, ${actorId})`);
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
              rqRemittancePartyId: rqVendorId,
            },
          })}::jsonb where id = ${org.orgId}`);
        await seedPayrollComponents(org.orgId, actorId, "CA");
        await setPackSlotAccount(org.orgId, actorId, "CA", "qc_income_tax", qcPayable);
        await db.execute(sql`
          update pay_components set remittance_party_id = ${rqVendorId}
           where org_id = ${org.orgId} and system_key = 'qc_income_tax'`);
        // A QC employer always owes the HSF at its own rate: an unclassified
        // employer refuses by name at calculate, so the fixture classifies
        // ordinary-sector (this test asserts QPIP, never HSF).
        const hsfPayable = await account("2360", "HSF payable", "liability_current");
        await setPackSlotAccount(org.orgId, actorId, "CA", "hsf", hsfPayable);
        await db.execute(sql`
          insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                               rate_values, created_by, updated_by)
          values (${org.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"sectorOther": "true"}',
                  ${actorId}, ${actorId})`);

        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', 'Jean Tremblay', true, '{}'::jsonb)`);
        const qpipEmploymentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                        is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, 'CAD', '5000', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
        const scheduleId = randomUUID();
        await db.execute(sql`
          insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                     pay_date_offset_days, is_active, created_by, updated_by)
          values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                  ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                                 country, province, pay_basis, federal_claim_code,
                                                 vacation_percent, vacation_method, is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${qpipEmploymentId}, ${scheduleId}, 'CA', 'QC', 'hourly', 1,
                  '0', 'accrue', true, ${actorId}, ${actorId})`);

        // The QC stubs price CNT too: classify the employer (asserted nowhere in this test).
        await seedCntSubjectEmployerFixture(org.orgId, actorId, org.subsidiaryId, craPayable);

        const employerQpip: string[] = [];
        for (const [start, end, days] of [
          ["2026-07-05", "2026-07-18", ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]],
          ["2026-07-19", "2026-08-01", ["2026-07-20", "2026-07-22", "2026-07-24", "2026-07-28"]],
        ] as const) {
          for (const workedOn of days) {
            await db.execute(sql`
              insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                        billing_status, costing_basis, created_by, updated_by)
              values (${org.orgId}, ${employeeId}, ${workedOn}, 20, 'approved', false,
                      'unbilled', 'actual', ${actorId}, ${actorId})`);
          }
          const run = await createPayRun({
            orgId: org.orgId, actorId, payScheduleId: scheduleId,
            periodStart: start, periodEnd: end,
          });
          const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
          assert.deepEqual(result.errors, []);
          const factors = (await db.execute<{ factors: unknown }>(sql`
            select factors from pay_stubs
             where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
          `)).rows[0]!.factors as Record<string, string>;
          employerQpip.push(factors.QPIP_ER!);
          await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        }

        assert.equal(employerQpip[0], "620.0600", "first period takes the whole annual maximum");
        assert.equal(employerQpip[1], "0.0000", "second period accrues nothing once the maximum is reached");
        assert.equal(
          add(employerQpip[0]!, employerQpip[1]!),
          "620.0600",
          "the year accrues exactly the employer maximum, never past it",
        );
      } finally {
        await dropScratchOrgReporting(org.orgId);
      }
    },
  );
});

describe("rl1-openings", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  /**
   * The RL-1's opening-balance carry-in, end to end.
   *
   * A mid-year adopter's Québec employees carry pre-adoption YTD on
   * `payroll_opening_balances`. The T4 folds it into boxes 14/16/16A/18/22/24/26
   * and the W-2 into 1/2/3/5; the RL-1 used to read committed stubs only, so
   * the same employee's RL-1 understated boxes A/B.A/B.B/C/H/G against their
   * own T4 and against the prior provider's YTD report. These tests pin the
   * carry-in (and its deliberate exclusions: boxes E/F have no opening source,
   * exactly as the T4 refuses 44) through `rl1Slips` itself. Box I reads the
   * QPIP program's OWN base — the stub's IE_QPIP factor, never the EI leg —
   * plus the program carry-in, capped at the QPIP maximum (C-12/C-13).
   */

  type QcFixture = {
    orgId: string;
    actorId: string;
    qcStubEmployee: string;
    qcOpeningOnlyEmployee: string;
    onOpeningOnlyEmployee: string;
  };

  async function seedQcYear(): Promise<QcFixture> {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;

    const earningId = randomUUID();
    const qcTaxId = randomUUID();
    const unionId = randomUUID();
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, country, taxable, created_by, updated_by)
      values (${earningId}, ${org.orgId}, 'SAL', 'Salary', 'earning', 'CA', true, ${actorId}, ${actorId}),
             (${qcTaxId}, ${org.orgId}, 'QCTAX', 'Quebec tax', 'deduction', 'CA', false, ${actorId}, ${actorId}),
             (${unionId}, ${org.orgId}, 'DUES', 'Union dues', 'deduction', 'CA', false, ${actorId}, ${actorId})`);
    await db.execute(sql`
      update pay_components set system_key = 'qc_income_tax' where id = ${qcTaxId} and org_id = ${org.orgId}`);
    await db.execute(sql`
      update pay_components set tax_treatment = 'union_dues' where id = ${unionId} and org_id = ${org.orgId}`);

    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
              ${actorId}, ${actorId})`);

    const qcStubEmployee = randomUUID();
    const qcOpeningOnlyEmployee = randomUUID();
    const onOpeningOnlyEmployee = randomUUID();
    let qcStubEmploymentId = "";
    for (const [id, name, province] of [
      [qcStubEmployee, "Marie Tremblay", "QC"],
      [qcOpeningOnlyEmployee, "Jean Lapointe", "QC"],
      [onOpeningOnlyEmployee, "Oliver Twist", "ON"],
    ] as const) {
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
        values (${id}, ${org.orgId}, 'person', ${name}, true, ${org.subsidiaryId}, '{}'::jsonb)`);
      const employmentId = await seedWorkerEmployment(org.orgId, id, org.subsidiaryId);
      if (id === qcStubEmployee) qcStubEmploymentId = employmentId;
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id, province,
                                               pay_basis, country, federal_claim_code,
                                               provincial_claim_code, vacation_percent, vacation_method,
                                               is_active, created_by, updated_by)
        values (${org.orgId}, ${id}, ${employmentId}, ${scheduleId}, ${province}, 'hourly', 'CA', 1, 1, '4', 'accrue',
                true, ${actorId}, ${actorId})`);
    }

    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                             currency, status, created_by, updated_by)
      values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
              ${org.subsidiaryId}, '2026-07-21', 'CAD', 'draft', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                            tax_year, run_status, calculated_at, created_by, updated_by)
      values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18', '2026-07-21',
              2026, 'committed', now(), ${actorId}, ${actorId})`);

    const stubId = randomUUID();
    // The stub's QPIP program base DIVERGES from its EI base on purpose:
    // 30,000 EI-insurable but only 22,000 QPIP-insurable (benefits the QPIP
    // program excludes). Box I must follow the program factor, never EI.
    await db.execute(sql`
      insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id, province,
                             periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                             pensionable_earnings, insurable_earnings, factors, created_by, updated_by)
      values (${stubId}, ${org.orgId}, ${documentId}, ${qcStubEmployee}, ${qcStubEmploymentId}, 'QC', 26, '2026-07-21',
              2026, 'CAD', '30000.0000', '24000.0000', '30000.0000', '30000.0000',
              ${JSON.stringify({ C: "1500.00", EI: "390.00", QPIP: "129.00", IE_QPIP: "22000.00" })}::jsonb,
              ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                  created_by, updated_by)
      values (${org.orgId}, ${stubId}, ${earningId}, 'earning', 'Salary', '30000.0000',
              ${actorId}, ${actorId}),
             (${org.orgId}, ${stubId}, ${qcTaxId}, 'deduction', 'Quebec tax', '2000.0000',
              ${actorId}, ${actorId}),
             (${org.orgId}, ${stubId}, ${unionId}, 'deduction', 'Union dues', '300.0000',
              ${actorId}, ${actorId})`);

    // Prior-provider YTD for all three employees. The ON employee's row proves
    // the RL-1 does not conjure a Québec slip from an opening alone.
    for (const [id, taxable, pensionable] of [
      [qcStubEmployee, "10000.0000", "10000.0000"],
      [qcOpeningOnlyEmployee, "5000.0000", "5000.0000"],
      [onOpeningOnlyEmployee, "7000.0000", "7000.0000"],
    ] as const) {
      await db.execute(sql`
        insert into payroll_opening_balances (org_id, employee_party_id, tax_year, pensionable_ytd,
                                              insurable_ytd, cpp_ytd, cpp2_ytd, ei_ytd, qpip_ytd,
                                              taxable_ytd, tax_ytd, created_by, updated_by)
        values (${org.orgId}, ${id}, 2026, ${pensionable}, '9000.0000', '500.0000', '50.0000',
                '100.0000', '40.0000', ${taxable}, '1500.0000', ${actorId}, ${actorId})`);
    }

    // Pre-adoption QPIP-insurable earnings for the two Québec employees: the
    // stub employee's 8,000 joins the stub's 22,000 program base, while the
    // opening-only employee's 4,000 is box I's entire content (C-13).
    await db.execute(sql`
      insert into payroll_opening_program_bases (org_id, employee_party_id, tax_year, program_key,
                                                 insurable_ytd, created_by, updated_by)
      values (${org.orgId}, ${qcStubEmployee}, 2026, 'qpip', '8000.0000', ${actorId}, ${actorId}),
             (${org.orgId}, ${qcOpeningOnlyEmployee}, 2026, 'qpip', '4000.0000', ${actorId}, ${actorId})`);

    return { orgId: org.orgId, actorId, qcStubEmployee, qcOpeningOnlyEmployee, onOpeningOnlyEmployee };
  }

  test(
    "RL-1 folds pre-adoption YTD into boxes A/B.A/B.B/C/H/G, before the caps",
    { skip: !DB },
    async () => {
      const fx = await seedQcYear();
      try {
        const slips = await rl1Slips(fx.orgId, 2026);
        const stub = slips.find((slip) => slip.employeePartyId === fx.qcStubEmployee);
        assert.ok(stub, "the QC employee with committed stubs has an RL-1 slip");
        assert.equal(stub.boxA, "40000.0000", "30000 stubs + 10000 opening");
        assert.equal(stub.boxBA, "2000.0000", "1500 QPP + 500 opening");
        assert.equal(stub.boxBB, "50.0000", "0 + 50 opening");
        assert.equal(stub.boxC, "490.0000", "390 EI + 100 opening");
        assert.equal(stub.boxH, "169.0000", "129 QPIP + 40 opening");
        assert.equal(stub.boxG, "40000.0000", "30000 + 10000 pensionable, under the YMPE");
        assert.equal(stub.boxI, "30000.0000", "22000 program base + 8000 carried, never the 30000 EI leg");
        assert.equal(stub.boxE, "2000.0000", "stub QC tax only: tax_ytd is federal money");
        assert.equal(stub.boxF, "300.0000", "stub dues only: no union-dues YTD column");
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );

  test(
    "RL-1 seeds a slip for an opening-only Québec employee, and none for an Ontario one",
    { skip: !DB },
    async () => {
      const fx = await seedQcYear();
      try {
        const slips = await rl1Slips(fx.orgId, 2026);
        const seeded = slips.find((slip) => slip.employeePartyId === fx.qcOpeningOnlyEmployee);
        assert.ok(seeded, "an opening-only QC employee appears on the RL-1");
        assert.equal(seeded.stubCount, 0);
        assert.equal(seeded.boxA, "5000.0000");
        assert.equal(seeded.boxBA, "500.0000");
        assert.equal(seeded.boxBB, "50.0000");
        assert.equal(seeded.boxC, "100.0000");
        assert.equal(seeded.boxH, "40.0000");
        assert.equal(seeded.boxG, "5000.0000");
        assert.equal(seeded.boxI, "4000.0000", "the carried program base alone: no stubs, no EI backfill");
        assert.ok(
          !slips.some((slip) => slip.employeePartyId === fx.onOpeningOnlyEmployee),
          "an opening-only ON employee gets no RL-1 slip",
        );
        const summary = await rl1Summary(fx.orgId, 2026);
        assert.equal(summary.slips, 2);
        assert.equal(summary.boxA, "45000.0000");
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
});
