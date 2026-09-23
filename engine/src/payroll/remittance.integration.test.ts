import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, sum } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { recordPayRunPayment } from "./payment.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import {
  createRemittanceBill,
  payrollRemittanceSummary,
  remittanceFenceLockKey,
} from "./remittance.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { t4Slips, t4Summary } from "./yearend.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type RemittanceFixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  actorId: string;
  componentId: string;
  liabilityAccountId: string;
  scheduleId: string;
};

/** A deliberately small committed-payroll fixture for remittance race tests.
 * It writes only the rows the summary reads, leaving statutory calculation to
 * the first end-to-end test above. */
async function createRemittanceFixture(): Promise<RemittanceFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const liabilityAccountId = randomUUID();
  const componentId = randomUUID();
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_include_children)
    values
      (${liabilityAccountId}, ${org.orgId}, ${`23${componentId.slice(0, 2)}`},
       'Remittance liability', 'liability_current', false, true, false, false,
       '[]'::jsonb, '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${org.orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
    on conflict do nothing`);
  await db.execute(sql`
    insert into pay_components
      (id, org_id, code, name, kind, system_key, liability_account_id,
       remittance_party_id, sequence, country, created_by, updated_by)
    values
      (${componentId}, ${org.orgId}, ${`TESTTAX-${componentId.slice(0, 6)}`},
       'Test withholding', 'deduction', 'income_tax', ${liabilityAccountId},
       ${org.vendorId}, 10, 'CA', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values
      (${scheduleId}, ${org.orgId}, 'Remittance race schedule', 'monthly', 12,
       '2026-01-31', 0, true, ${actorId}, ${actorId})`);
  return { org, actorId, componentId, liabilityAccountId, scheduleId };
}

async function addCommittedRemittanceAccrual(
  fixture: RemittanceFixture,
  input: { payDate: string; amount: string; employeeId?: string; snapshotPartyId?: string },
): Promise<void> {
  const { org, actorId, componentId, liabilityAccountId, scheduleId } = fixture;
  const employeeId = input.employeeId ?? randomUUID();
  const documentId = randomUUID();
  const stubId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id,
                         is_active, custom, created_by, updated_by)
    values (${employeeId}, ${org.orgId}, 'person', ${`Accrual ${employeeId.slice(0, 6)}`},
            ${org.subsidiaryId}, true, '{}'::jsonb, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       posting_date, posting_period_id, currency, status, memo, created_by,
       updated_by)
    values
      (${documentId}, ${org.orgId}, 'pay_run', ${`REM-${documentId.slice(0, 8)}`},
       ${org.subsidiaryId}, ${input.payDate}, ${input.payDate}, ${org.periodId},
       'CAD', 'draft', 'Remittance race source', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
       tax_year, run_status, run_type, created_by, updated_by)
    values
      (${documentId}, ${org.orgId}, ${scheduleId}, ${input.payDate}, ${input.payDate},
       ${input.payDate}, 2026, 'committed', 'regular', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, currency_code, gross,
       pensionable_earnings, insurable_earnings, net_pay, employer_cost,
       vacation_accrued, factors, created_by, updated_by)
    values
      (${stubId}, ${org.orgId}, ${documentId}, ${employeeId}, 'ON', 12,
       ${input.payDate}, 2026, 'CAD', ${input.amount}, ${input.amount},
       ${input.amount}, ${input.amount}, ${input.amount}, '0', '{}'::jsonb,
       ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount, sequence,
       liability_account_id, liability_account_source, remittance_party_id, created_by, updated_by)
    values
      (${lineId}, ${org.orgId}, ${stubId}, ${componentId}, 'deduction',
       'Test withholding', ${input.amount}, 10, ${liabilityAccountId}, 'commit',
       ${input.snapshotPartyId ?? org.vendorId}, ${actorId}, ${actorId})`);
}

async function waitForRemittanceFenceWaiter(key: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = (await db.execute<{ waiting: boolean }>(sql`
      select exists (
        select 1
          from pg_locks
         where locktype = 'advisory' and not granted
           and classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
           and objid = (hashtextextended(${key}, 0) & 4294967295)
      ) as waiting
    `)).rows[0]?.waiting;
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("remittance fence waiter did not reach the advisory lock");
}

test(
  "a remittance bill cannot post after its payroll source is voided",
  { skip: !DB },
  async () => {
    const fixture = await createRemittanceFixture();
    try {
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-07-15", amount: "100.00",
      });
      const bill = await createRemittanceBill(fixture.org.orgId, fixture.actorId, {
        partyId: fixture.org.vendorId,
        from: "2026-07-01",
        to: "2026-07-31",
      });

      // A controlled payroll void retires the source from every statutory
      // consumer. The already-created draft bill is now a stale snapshot and
      // must not be allowed to move money through the generic AP poster.
      await db.execute(sql`
        update pay_runs set run_status = 'voided'
         where org_id = ${fixture.org.orgId}`);
      await submitAndReleaseIfUngated("vendor_bill", bill.documentId, fixture.actorId);
      await assert.rejects(
        postDocument(bill.documentId, {
          control: {
            ar: fixture.org.accounts.ar,
            ap: fixture.org.accounts.ap,
            bank: fixture.org.accounts.bank,
          },
        }),
        /payroll remittance.*(?:voided|no longer)|no longer.*matches committed payroll/i,
      );
      assert.equal(
        (await db.execute<{ status: string }>(sql`
          select status from documents where org_id = ${fixture.org.orgId} and id = ${bill.documentId}`)).rows[0]!.status,
        "approved",
        "a stale remittance bill remains unposted for review/voiding",
      );
    } finally {
      await dropScratchOrgReporting(fixture.org.orgId);
    }
  },
);

test(
  "voiding payroll is blocked while a posted remittance bill covers it",
  { skip: !DB },
  async () => {
    const fixture = await createRemittanceFixture();
    try {
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-07-15", amount: "100.00",
      });
      const bill = await createRemittanceBill(fixture.org.orgId, fixture.actorId, {
        partyId: fixture.org.vendorId,
        from: "2026-07-01",
        to: "2026-07-31",
      });

      const expenseAccount = randomUUID();
      await db.execute(sql`
        insert into accounts
          (id, org_id, number, name, type, is_summary, is_active, eliminate,
           reconcilable, required_dimensions, custom, subsidiary_include_children)
        values
          (${expenseAccount}, ${fixture.org.orgId}, '6100', 'Payroll expense', 'expense',
           false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      const source = (await db.execute<{ document_id: string }>(sql`
        select document_id from pay_runs where org_id = ${fixture.org.orgId} limit 1`)).rows[0]!;
      await db.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, amount, created_by)
        values
          (${fixture.org.orgId}, ${source.document_id}, 1, ${expenseAccount}, '100', ${fixture.actorId}),
          (${fixture.org.orgId}, ${source.document_id}, 2, ${fixture.liabilityAccountId}, '-100', ${fixture.actorId})`);
      await db.execute(sql`
        update documents set status = 'approved'
         where org_id = ${fixture.org.orgId} and id = ${source.document_id}`);
      await postDocument(source.document_id, {
        control: {
          ar: fixture.org.accounts.ar,
          ap: fixture.org.accounts.ap,
          bank: fixture.org.accounts.bank,
        },
      });

      await submitAndReleaseIfUngated("vendor_bill", bill.documentId, fixture.actorId);
      await postDocument(bill.documentId, {
        control: {
          ar: fixture.org.accounts.ar,
          ap: fixture.org.accounts.ap,
          bank: fixture.org.accounts.bank,
        },
      });
      await assert.rejects(
        requestDocumentVoid({
          orgId: fixture.org.orgId,
          documentId: source.document_id,
          actorId: fixture.actorId,
          reason: "remittance bill must be resolved first",
          reversalDate: fixture.org.date,
          source: "api",
        }),
        /posted payroll remittance bill.*void|void.*remittance bill/i,
      );
      assert.equal(
        (await db.execute<{ status: string }>(sql`
          select status from documents where org_id = ${fixture.org.orgId} and id = ${source.document_id}`)).rows[0]!.status,
        "posted",
        "the source payroll remains posted when the void is refused",
      );
    } finally {
      await dropScratchOrgReporting(fixture.org.orgId);
    }
  },
);

test(
  "remittance run: accrued CRA liabilities → draft vendor bill; T4 boxes reconcile",
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
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA payable", "liability_current");
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      // org.vendorId (Acme Vendor) doubles as the CRA remittance vendor.
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${org.orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
        on conflict do nothing`);
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense, burdenExpenseAccountId: wageExpense,
            netPayAccountId: netPayable, cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable, taxPayableAccountId: craPayable,
            vacationPayableAccountId: vacationPayable, wagesTo: "expense",
            craRemittancePartyId: org.vendorId,
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Remi Trent', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '104000', 'year', '2080', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1,
                '4', 'accrue', true, ${actorId}, ${actorId})`);

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

      const stub = ((await db.execute<{ gross: string; factors: Record<string, string> }>(sql`
        select gross, factors from pay_stubs where pay_run_document_id = ${run.documentId}
      `))).rows[0]!;

      // Summary: one CRA group; vacation accrual excluded; totals reconcile.
      const groups = await payrollRemittanceSummary(org.orgId, { from: "2026-07-01", to: "2026-07-31" });
      assert.equal(groups.length, 1);
      const cra = groups[0]!;
      assert.equal(cra.partyId, org.vendorId);
      assert.ok(!cra.components.some((c) => c.systemKey === "vacation_accrual"));
      const expectedTotal = sum([
        add(stub.factors.T!, stub.factors.TB ?? "0"),     // income tax
        stub.factors.C!,                                   // employee CPP
        stub.factors.EI!,                                  // employee EI
        add(stub.factors.C!, stub.factors.C2 ?? "0"),      // employer CPP match
        stub.factors.EI_ER!,                               // employer EI
      ]);
      assert.equal(cmp(cra.total, expectedTotal), 0);
      assert.equal(cra.employeeCount, 1);

      // Bill: draft vendor_bill debiting the liability account, marked for the period.
      const bill = await createRemittanceBill(org.orgId, actorId, {
        partyId: org.vendorId, from: "2026-07-01", to: "2026-07-31",
      });
      const billDoc = ((await db.execute<{
        status: string;
        total: string;
        due_date: string;
        custom: Record<string, unknown> | null;
      }>(sql`
        select status, total, due_date, custom from documents where id = ${bill.documentId}
      `))).rows[0]!;
      assert.equal(billDoc.status, "draft");
      assert.equal(cmp(billDoc.total, cra.total), 0);
      // The 15th of the following month, moved off the weekend: August 15 2026
      // is a Saturday, and the CRA's own rule is that the remittance is on
      // time if it is received on the next business day. Before the statutory
      // holiday calendar existed this stamped the Saturday.
      assert.equal(billDoc.due_date, "2026-08-17");
      const billLines = ((await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount from document_lines where document_id = ${bill.documentId}
      `))).rows;
      assert.ok(billLines.every((l) => l.account_id === craPayable));
      assert.equal(cmp(sum(billLines.map((l) => l.amount)), cra.total), 0);

      // The raised bill shows on the next summary for the same period.
      const after = await payrollRemittanceSummary(org.orgId, { from: "2026-07-01", to: "2026-07-31" });
      assert.equal(after[0]!.existingBills.length, 1);
      assert.equal(after[0]!.existingBills[0]!.documentNumber, bill.documentNumber);

      // Post the run, then record payment: DR net payable per employee
      // (applied to the run's open items) / CR bank; run stamped paid.
      await db.execute(sql`update documents set status = 'approved' where id = ${run.documentId}`);
      await postDocument(run.documentId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
      const transferredTo = randomUUID();
      await db.execute(sql`insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
        values(${transferredTo},${org.orgId},${org.subsidiaryId},'New employer','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb)`);
      await db.execute(sql`update parties set subsidiary_id=${transferredTo}
        where org_id=${org.orgId} and id=${employeeId}`);
      await db.execute(sql`update accounts set subsidiary_id=${transferredTo},subsidiary_include_children=false
        where org_id=${org.orgId} and id=${org.accounts.bank}`);
      await assert.rejects(recordPayRunPayment({
        orgId: org.orgId, actorId, documentId: run.documentId, bankAccountId: org.accounts.bank,
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      }), /restricted to another subsidiary/, "payroll cannot credit a bank account owned by another legal entity");
      await db.execute(sql`update accounts set subsidiary_id=null
        where org_id=${org.orgId} and id=${org.accounts.bank}`);
      const payment = await recordPayRunPayment({
        orgId: org.orgId, actorId, documentId: run.documentId, bankAccountId: org.accounts.bank,
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      });
      const stubNet = ((await db.execute<{ net_pay: string }>(sql`
        select net_pay from pay_stubs where pay_run_document_id = ${run.documentId}
      `))).rows[0]!;
      assert.equal(cmp(payment.total, stubNet.net_pay), 0);
      const paidRun = ((await db.execute<{ paid_at: string | null; paid_entry_id: string | null }>(sql`
        select paid_at, paid_entry_id from pay_runs where document_id = ${run.documentId}
      `))).rows[0]!;
      assert.ok(paidRun.paid_at && paidRun.paid_entry_id);
      const settlement = ((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from applications a
          join journal_lines jl on jl.id = a.from_line_id
         where jl.entry_id = ${paidRun.paid_entry_id}
      `))).rows[0]!;
      assert.equal(settlement.n, 1); // one employee, one applied open item
      await assert.rejects(
        recordPayRunPayment({
          orgId: org.orgId, actorId, documentId: run.documentId, bankAccountId: org.accounts.bank,
        }),
        /already recorded as paid/,
      );

      // T4: boxes reconcile to the stub.
      const slips = await t4Slips(org.orgId, 2026);
      assert.equal(slips.length, 1);
      const slip = slips[0]!;
      assert.equal(cmp(slip.box14EmploymentIncome, stub.gross), 0);
      assert.equal(cmp(slip.box16Cpp, stub.factors.C!), 0);
      assert.equal(cmp(slip.box18Ei, stub.factors.EI!), 0);
      assert.equal(cmp(slip.box22IncomeTax, add(stub.factors.T!, stub.factors.TB ?? "0")), 0);
      const summary = await t4Summary(org.orgId, 2026);
      assert.equal(summary.slips, 1);
      assert.equal(cmp(summary.employmentIncome, stub.gross), 0);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "mixed-subsidiary pay run payment balances each legal entity",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const childSubsidiaryId = randomUUID();
      const netPayableId = randomUUID();
      const dueFromId = randomUUID();
      const dueToId = randomUUID();
      const scheduleId = randomUUID();
      const documentId = randomUUID();
      const postedEntryId = randomUUID();
      const rootEmployeeId = randomUUID();
      const childEmployeeId = randomUUID();

      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids,
           is_elimination, is_active, custom)
        values
          (${childSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Child Co',
           'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into accounts
          (id, org_id, number, name, type, is_summary, is_active, eliminate,
           reconcilable, required_dimensions, custom, subsidiary_include_children)
        values
          (${netPayableId}, ${org.orgId}, '2300', 'Net pay payable',
           'liability_current', false, true, false, false, '[]'::jsonb,
           '{}'::jsonb, true),
          (${dueFromId}, ${org.orgId}, '1410', 'Due from Child Co',
           'asset_current_other', false, true, true, false, '[]'::jsonb,
           '{}'::jsonb, true),
          (${dueToId}, ${org.orgId}, '2410', 'Due to Main Co',
           'liability_current_other', false, true, true, false, '[]'::jsonb,
           '{}'::jsonb, true)`);
      await db.execute(sql`
        insert into intercompany_pairs
          (id, org_id, from_subsidiary_id, to_subsidiary_id,
           due_from_account_id, due_to_account_id, is_active, created_by, updated_by)
        values
          (${randomUUID()}, ${org.orgId}, ${org.subsidiaryId}, ${childSubsidiaryId},
           ${dueFromId}, ${dueToId}, true, ${actorId}, ${actorId})`);
      await db.execute(sql`
        update orgs
           set settings = settings || ${JSON.stringify({
             payroll: { netPayAccountId: netPayableId },
           })}::jsonb
         where id = ${org.orgId}`);
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id,
                             is_active, custom, created_by, updated_by)
        values
          (${rootEmployeeId}, ${org.orgId}, 'person', 'Root Employee',
           ${org.subsidiaryId}, true, '{}'::jsonb, ${actorId}, ${actorId}),
          (${childEmployeeId}, ${org.orgId}, 'person', 'Child Employee',
           ${childSubsidiaryId}, true, '{}'::jsonb, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into pay_schedules
          (id, org_id, name, frequency, periods_per_year, anchor_period_end,
           pay_date_offset_days, is_active, created_by, updated_by)
        values
          (${scheduleId}, ${org.orgId}, 'Mixed Co Schedule', 'monthly', 12,
           '2026-07-31', 0, true, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, subsidiary_id, document_date,
           posting_date, posting_period_id, currency, status, memo, created_by,
           updated_by)
        values
          (${documentId}, ${org.orgId}, 'pay_run', 'PAY-MIXED-001',
           ${org.subsidiaryId}, '2026-07-15', '2026-07-15', ${org.periodId},
           'CAD', 'draft', 'Mixed subsidiary payment fixture', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, origin, source_document_id, created_by,
           updated_by)
        values
          (${postedEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-MIXED-SOURCE', '2026-07-15', ${org.periodId},
           'Mixed subsidiary payroll accrual', 'draft', 'payroll', ${documentId},
           ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, party_id, is_open_item, memo)
        values
          (${org.orgId}, ${postedEntryId}, 1, ${org.accounts.cogs},
           ${org.subsidiaryId}, '100.0000', 'CAD', '100.0000', 1,
           null, false, 'Root wages'),
          (${org.orgId}, ${postedEntryId}, 2, ${netPayableId},
           ${org.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', 1,
           ${rootEmployeeId}, true, 'Root net pay'),
          (${org.orgId}, ${postedEntryId}, 3, ${org.accounts.cogs},
           ${childSubsidiaryId}, '150.0000', 'CAD', '150.0000', 1,
           null, false, 'Child wages'),
          (${org.orgId}, ${postedEntryId}, 4, ${netPayableId},
           ${childSubsidiaryId}, '-150.0000', 'CAD', '-150.0000', 1,
           ${childEmployeeId}, true, 'Child net pay')`);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actorId}
         where id = ${postedEntryId} and org_id = ${org.orgId}`);
      await db.execute(sql`
        update documents
           set status = 'posted', posted_entry_id = ${postedEntryId},
               updated_at = now(), updated_by = ${actorId}
         where id = ${documentId} and org_id = ${org.orgId}`);
      await db.execute(sql`
        insert into pay_runs
          (document_id, org_id, pay_schedule_id, period_start, period_end,
           pay_date, tax_year, run_status, run_type, created_by, updated_by)
        values
          (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-01', '2026-07-15',
           '2026-07-15', 2026, 'committed', 'regular', ${actorId}, ${actorId})`);

      const rootOnlyPayment = () => recordPayRunPayment({
        orgId: org.orgId, actorId, documentId, bankAccountId: org.accounts.bank,
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      });
      await assert.rejects(rootOnlyPayment, /pay run not found/);
      // Current employment does not transfer an already-posted liability.
      await db.execute(sql`update parties set subsidiary_id=${org.subsidiaryId}
        where org_id=${org.orgId} and id=${childEmployeeId}`);
      await assert.rejects(rootOnlyPayment, /pay run not found/,
        "moving the employee cannot authorize settlement of the hidden originating entity");

      const payAll = () => recordPayRunPayment({
        orgId: org.orgId, actorId, documentId, bankAccountId: org.accounts.bank,
      });
      await db.execute(sql`update accounts set subsidiary_id=${childSubsidiaryId},subsidiary_include_children=false
        where org_id=${org.orgId} and id=${dueFromId}`);
      await assert.rejects(payAll, /restricted to another subsidiary/,
        "new intercompany balancing legs obey their own account ownership");
      await db.execute(sql`update accounts set subsidiary_id=null where org_id=${org.orgId} and id=${dueFromId}`);
      await db.execute(sql`update subsidiaries set is_active=false where org_id=${org.orgId} and id=${childSubsidiaryId}`);
      await assert.rejects(payAll, /inactive/, "every settled entity must be active");
      await db.execute(sql`update subsidiaries set is_active=true where org_id=${org.orgId} and id=${childSubsidiaryId}`);
      const beforePayment = (await db.execute<{ paid_at: string | null; entries: number }>(sql`
        select r.paid_at,(select count(*)::int from journal_entries e where e.org_id=r.org_id) as entries
          from pay_runs r where r.org_id=${org.orgId} and r.document_id=${documentId}`)).rows[0]!;
      assert.deepEqual(beforePayment, { paid_at: null, entries: 1 }, "all refusals leave only the source journal");

      const payment = await recordPayRunPayment({
        orgId: org.orgId,
        actorId,
        documentId,
        bankAccountId: org.accounts.bank,
      });
      assert.equal(cmp(payment.total, "250"), 0);

      const paymentEntry = (await db.execute<{
        origin: string;
      }>(sql`
        select origin from journal_entries
         where org_id = ${org.orgId} and id = ${payment.entryId}
      `)).rows[0]!;
      assert.equal(paymentEntry.origin, "intercompany");

      const subsidiaryBalances = (await db.execute<{
        subsidiary_id: string; total: string;
      }>(sql`
        select subsidiary_id, sum(amount)::text as total
          from journal_lines
         where org_id = ${org.orgId} and entry_id = ${payment.entryId}
         group by subsidiary_id
         order by subsidiary_id
      `)).rows;
      assert.equal(subsidiaryBalances.length, 2);
      assert.ok(subsidiaryBalances.every((row) => cmp(row.total, "0") === 0));

      const dueLegs = (await db.execute<{
        account_id: string; subsidiary_id: string; amount: string;
      }>(sql`
        select account_id, subsidiary_id, amount::text as amount
          from journal_lines
         where org_id = ${org.orgId} and entry_id = ${payment.entryId}
           and account_id in (${dueFromId}, ${dueToId})
         order by subsidiary_id
      `)).rows;
      const dueByAccount = new Map(dueLegs.map((row) => [row.account_id, row]));
      assert.deepEqual(dueByAccount.get(dueFromId), {
        account_id: dueFromId, subsidiary_id: org.subsidiaryId, amount: "150.0000",
      });
      assert.deepEqual(dueByAccount.get(dueToId), {
        account_id: dueToId, subsidiary_id: childSubsidiaryId, amount: "-150.0000",
      });

      const applications = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from applications a
          join journal_lines jl on jl.id = a.from_line_id
         where a.org_id = ${org.orgId} and jl.entry_id = ${payment.entryId}
      `)).rows[0]!;
      assert.equal(applications.n, 2);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "remittance bills reject overlapping live periods for one destination",
  { skip: !DB },
  async () => {
    const fixture = await createRemittanceFixture();
    try {
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-01-15", amount: "10.00",
      });
      await createRemittanceBill(fixture.org.orgId, fixture.actorId, {
        partyId: fixture.org.vendorId, from: "2026-01-01", to: "2026-01-31",
      });

      await assert.rejects(
        createRemittanceBill(fixture.org.orgId, fixture.actorId, {
          partyId: fixture.org.vendorId, from: "2026-01-15", to: "2026-02-15",
        }),
        /overlaps 2026-01-01 – 2026-01-31/,
      );
      const bills = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from documents
         where org_id = ${fixture.org.orgId} and kind = 'vendor_bill'
           and custom->'payrollRemittance'->>'partyId' = ${fixture.org.vendorId}
           and status <> 'voided'
      `)).rows[0]!;
      assert.equal(bills.n, 1);
      const overlappingSummary = await payrollRemittanceSummary(fixture.org.orgId, {
        from: "2026-01-15", to: "2026-02-15",
      });
      assert.equal(overlappingSummary[0]!.existingBills.length, 1);
    } finally {
      await dropScratchOrgReporting(fixture.org.orgId);
    }
  },
);

test(
  "a later same-period run bills only its unbilled lines, never twice",
  { skip: !DB },
  async () => {
    const fixture = await createRemittanceFixture();
    try {
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-01-15", amount: "10.00",
      });
      const first = await createRemittanceBill(fixture.org.orgId, fixture.actorId, {
        partyId: fixture.org.vendorId, from: "2026-01-01", to: "2026-01-31",
      });
      // A second accrual lands after the first bill: the same window now
      // holds $10 of consumed lines and $5 of fresh ones.
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-01-20", amount: "5.00",
      });
      const second = await createRemittanceBill(fixture.org.orgId, fixture.actorId, {
        partyId: fixture.org.vendorId, from: "2026-01-01", to: "2026-01-31",
      });
      assert.notEqual(second.documentId, first.documentId);
      const totals = (await db.execute<{ id: string; total: string }>(sql`
        select id::text as id, total::text as total
          from documents
         where org_id = ${fixture.org.orgId} and kind = 'vendor_bill'
           and custom->'payrollRemittance'->>'partyId' = ${fixture.org.vendorId}
           and status <> 'voided'
      `)).rows;
      assert.equal(totals.length, 2);
      const byId = new Map(totals.map((row) => [row.id, row.total]));
      assert.equal(cmp(byId.get(first.documentId)!, "10.00"), 0);
      assert.equal(cmp(byId.get(second.documentId)!, "5.00"), 0);
      // No double bill: every consumed line is covered exactly once, by the
      // bill that billed it, and the two bills' coverage never shares a line.
      const coverage = (await db.execute<{ line: string; bills: number; amount: string }>(sql`
        select cov.stub_line_id::text as line, count(*)::int as bills,
               sum(cov.amount)::text as amount
          from payroll_remittance_coverage cov
          join documents bill
            on bill.id = cov.bill_document_id and bill.org_id = cov.org_id
         where cov.org_id = ${fixture.org.orgId} and bill.status <> 'voided'
         group by cov.stub_line_id
      `)).rows;
      assert.equal(coverage.length, 2);
      for (const row of coverage) assert.equal(row.bills, 1);
      assert.equal(
        cmp(sum(coverage.map((row) => row.amount)), "15.00"),
        0,
        "covered lines sum to the billed scope exactly once",
      );
      // Nothing left unbilled: an exact re-run keeps the duplicate refusal.
      await assert.rejects(
        createRemittanceBill(fixture.org.orgId, fixture.actorId, {
          partyId: fixture.org.vendorId, from: "2026-01-01", to: "2026-01-31",
        }),
        /already exists/,
      );
    } finally {
      await dropScratchOrgReporting(fixture.org.orgId);
    }
  },
);

test(
  "remittance bill snapshots accruals after the destination fence is released",
  { skip: !DB },
  async () => {
    const fixture = await createRemittanceFixture();
    // The fence is per (destination, filing account, entity): the fixture's
    // accruals post on the root subsidiary, so the holder takes the root's key.
    const key = remittanceFenceLockKey(fixture.org.orgId, {
      partyId: fixture.org.vendorId, filingAccountId: null,
      subsidiaryId: fixture.org.subsidiaryId,
    });
    let release!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalReady!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${key}, 0))
      `);
      signalReady();
      await holderReady;
    });
    try {
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-01-15", amount: "10.00",
      });
      await lockReady;
      const creating = createRemittanceBill(fixture.org.orgId, fixture.actorId, {
        partyId: fixture.org.vendorId, from: "2026-01-01", to: "2026-01-31",
      });
      await waitForRemittanceFenceWaiter(key);

      // This commit happens while the creator waits on the shared fence. The
      // old preflight summary had already captured only the first accrual;
      // the fenced implementation must read both before inserting its bill.
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-01-20", amount: "20.00",
      });
      release();
      const bill = await creating;
      await holder;
      const total = (await db.execute<{ total: string }>(sql`
        select total::text as total from documents
         where org_id = ${fixture.org.orgId} and id = ${bill.documentId}
      `)).rows[0]!.total;
      assert.equal(cmp(total, "30"), 0);
    } finally {
      release();
      await holder;
      await dropScratchOrgReporting(fixture.org.orgId);
    }
  },
);

test(
  "a vendor change after commit keeps July's payee while future runs go to the new vendor",
  { skip: !DB },
  async () => {
    const fixture = await createRemittanceFixture();
    try {
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-07-15", amount: "100.00",
      });
      // The component's vendor changes in August: July's accrual must keep
      // payee A, while runs committed after the change remit to B.
      const vendorB = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id,
                             is_active, custom, created_by, updated_by)
        values (${vendorB}, ${fixture.org.orgId}, 'company', 'Local B',
                ${fixture.org.subsidiaryId}, true, '{}'::jsonb,
                ${fixture.actorId}, ${fixture.actorId})`);
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${fixture.org.orgId}, ${vendorB}, true, ${fixture.actorId}, ${fixture.actorId})`);
      await db.execute(sql`
        update pay_components set remittance_party_id = ${vendorB}
         where org_id = ${fixture.org.orgId} and id = ${fixture.componentId}`);

      const july = await payrollRemittanceSummary(fixture.org.orgId, {
        from: "2026-07-01", to: "2026-07-31",
      });
      assert.equal(july.length, 1);
      assert.equal(july[0]!.partyId, fixture.org.vendorId);

      // The unbilled July accrual still bills to A after the vendor change,
      // and coverage records exactly the July line.
      const billA = await createRemittanceBill(fixture.org.orgId, fixture.actorId, {
        partyId: fixture.org.vendorId, from: "2026-07-01", to: "2026-07-31",
      });
      const billTotal = (await db.execute<{ total: string }>(sql`
        select total::text as total from documents
         where org_id = ${fixture.org.orgId} and id = ${billA.documentId}`)).rows[0]!.total;
      assert.equal(cmp(billTotal, "100"), 0);
      const coverage = (await db.execute<{ lines: number; covered: string }>(sql`
        select count(*)::int as lines, coalesce(sum(amount), 0)::text as covered
          from payroll_remittance_coverage
         where org_id = ${fixture.org.orgId} and bill_document_id = ${billA.documentId}`)).rows[0]!;
      assert.equal(coverage.lines, 1);
      assert.equal(cmp(coverage.covered, "100"), 0);

      // A run committed after the change carries snapshot B and remits to B.
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-08-15", amount: "50.00", snapshotPartyId: vendorB,
      });
      const august = await payrollRemittanceSummary(fixture.org.orgId, {
        from: "2026-08-01", to: "2026-08-31",
      });
      assert.equal(august.length, 1);
      assert.equal(august[0]!.partyId, vendorB);
      assert.equal(cmp(august[0]!.total, "50"), 0);
    } finally {
      await dropScratchOrgReporting(fixture.org.orgId);
    }
  },
);

test(
  "a posted bill blocks a second bill for the same accruals after a vendor change",
  { skip: !DB },
  async () => {
    const fixture = await createRemittanceFixture();
    try {
      await addCommittedRemittanceAccrual(fixture, {
        payDate: "2026-07-15", amount: "100.00",
      });
      const first = await createRemittanceBill(fixture.org.orgId, fixture.actorId, {
        partyId: fixture.org.vendorId, from: "2026-07-01", to: "2026-07-31",
      });
      await submitAndReleaseIfUngated("vendor_bill", first.documentId, fixture.actorId);
      await postDocument(first.documentId, {
        control: {
          ar: fixture.org.accounts.ar,
          ap: fixture.org.accounts.ap,
          bank: fixture.org.accounts.bank,
        },
      });

      const vendorB = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id,
                             is_active, custom, created_by, updated_by)
        values (${vendorB}, ${fixture.org.orgId}, 'company', 'Local B',
                ${fixture.org.subsidiaryId}, true, '{}'::jsonb,
                ${fixture.actorId}, ${fixture.actorId})`);
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${fixture.org.orgId}, ${vendorB}, true, ${fixture.actorId}, ${fixture.actorId})`);
      await db.execute(sql`
        update pay_components set remittance_party_id = ${vendorB}
         where org_id = ${fixture.org.orgId} and id = ${fixture.componentId}`);

      // The July accruals still remit to A: there is nothing to bill to B,
      // so no second document is minted and no number is consumed.
      await assert.rejects(
        createRemittanceBill(fixture.org.orgId, fixture.actorId, {
          partyId: vendorB, from: "2026-07-01", to: "2026-07-31",
        }),
        /nothing to remit to this vendor for the period/,
      );
      const bills = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${fixture.org.orgId} and kind = 'vendor_bill'`)).rows[0]!.n;
      assert.equal(bills, 1);
    } finally {
      await dropScratchOrgReporting(fixture.org.orgId);
    }
  },
);

test(
  "commit snapshots the component vendor onto each accrual line",
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
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA payable", "liability_current");
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${org.orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
        on conflict do nothing`);
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense, burdenExpenseAccountId: wageExpense,
            netPayAccountId: netPayable, cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable, taxPayableAccountId: craPayable,
            vacationPayableAccountId: vacationPayable, wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");
      // The vendor assigned BEFORE commit is the one history must keep.
      await db.execute(sql`
        update pay_components set remittance_party_id = ${org.vendorId}
         where org_id = ${org.orgId} and country = 'CA'
           and kind in ('deduction', 'employer_contribution')`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Dues Dora', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '104000', 'year', '2080', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1,
                '4', 'accrue', true, ${actorId}, ${actorId})`);
      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

      const stamped = (await db.execute<{ stamped: number; total: number }>(sql`
        select count(*) filter (where remittance_party_id = ${org.vendorId})::int as stamped,
               count(*)::int as total
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
         where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
           and l.kind in ('deduction', 'employer_contribution', 'credit')`)).rows[0]!;
      assert.ok(stamped.total > 0);
      assert.equal(stamped.stamped, stamped.total);

      // A vendor edit after commit cannot move the frozen snapshot, and the
      // summary keeps routing the accrual to the commit-time payee.
      const vendorB = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${vendorB}, ${org.orgId}, 'company', 'Local B', true, '{}'::jsonb)`);
      await db.execute(sql`
        update pay_components set remittance_party_id = ${vendorB}
         where org_id = ${org.orgId} and country = 'CA'`);
      const frozen = (await db.execute<{ moved: number }>(sql`
        select count(*)::int as moved from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
         where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
           and l.kind in ('deduction', 'employer_contribution', 'credit')
           and l.remittance_party_id is distinct from ${org.vendorId}`)).rows[0]!.moved;
      assert.equal(frozen, 0);
      const groups = await payrollRemittanceSummary(org.orgId, {
        from: "2026-07-01", to: "2026-07-31",
      });
      assert.equal(groups.length, 1);
      assert.equal(groups[0]!.partyId, org.vendorId);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a liability account change across runs bills each historical account separately",
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
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const liabilityA = await account("2310", "CRA payable (old)", "liability_current");
      const liabilityB = await account("2311", "CRA payable (new)", "liability_current");
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${org.orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
        on conflict do nothing`);
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense, burdenExpenseAccountId: wageExpense,
            netPayAccountId: netPayable, cppPayableAccountId: liabilityA,
            eiPayableAccountId: liabilityA, taxPayableAccountId: liabilityA,
            vacationPayableAccountId: vacationPayable, wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);
      // Scratch orgs open July only; the second run pays in August.
      const calendar = (await db.execute<{ id: string }>(sql`
        select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`)).rows[0]!.id;
      await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                        is_adjustment, fiscal_calendar_id)
        values (${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${calendar})`);
      await seedPayrollComponents(org.orgId, actorId, "CA");
      const stampSetup = async (liability: string) => {
        await db.execute(sql`
          update pay_components set remittance_party_id = ${org.vendorId},
                 liability_account_id = ${liability}
           where org_id = ${org.orgId} and country = 'CA'
             and kind in ('deduction', 'employer_contribution')`);
      };
      await stampSetup(liabilityA);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Liability Larry', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '104000', 'year', '2080', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1,
                '4', 'accrue', true, ${actorId}, ${actorId})`);
      const postRun = async (periodStart: string, periodEnd: string) => {
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId, periodStart, periodEnd,
        });
        await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        await db.execute(sql`update documents set status = 'approved' where id = ${run.documentId}`);
        await postDocument(run.documentId, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
      };
      await postRun("2026-07-05", "2026-07-18");
      // Setup changes between runs: August accrues to the new account.
      await stampSetup(liabilityB);
      await postRun("2026-08-02", "2026-08-15");

      const july = await payrollRemittanceSummary(org.orgId, {
        from: "2026-07-01", to: "2026-07-31",
      });
      const august = await payrollRemittanceSummary(org.orgId, {
        from: "2026-08-01", to: "2026-08-31",
      });
      assert.equal(july.length, 1);
      assert.equal(august.length, 1);

      // The combined window keeps one line per historical account — never
      // one $150 line debiting the first account.
      const combined = await payrollRemittanceSummary(org.orgId, {
        from: "2026-07-01", to: "2026-08-31",
      });
      assert.equal(combined.length, 1);
      const group = combined[0]!;
      assert.equal(group.partyId, org.vendorId);
      // Several components accrue to each historical account, so the split
      // is asserted on per-account sums: July's total sits on A, August's on
      // B, and no component line mixes the two.
      const sumByAccount = new Map<string, string>();
      for (const component of group.components) {
        assert.ok(
          component.liabilityAccountId === liabilityA || component.liabilityAccountId === liabilityB,
          `component ${component.code} carries an unexpected liability account`,
        );
        sumByAccount.set(
          component.liabilityAccountId!,
          add(sumByAccount.get(component.liabilityAccountId!) ?? "0", component.amount),
        );
      }
      assert.equal(sumByAccount.size, 2);
      assert.equal(cmp(sumByAccount.get(liabilityA)!, july[0]!.total), 0);
      assert.equal(cmp(sumByAccount.get(liabilityB)!, august[0]!.total), 0);

      const bill = await createRemittanceBill(org.orgId, actorId, {
        partyId: org.vendorId, from: "2026-07-01", to: "2026-08-31",
      });
      const billLines = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id::text as account_id, amount::text as amount from document_lines
         where org_id = ${org.orgId} and document_id = ${bill.documentId}`)).rows;
      const billedByAccount = new Map<string, string>();
      for (const line of billLines) {
        billedByAccount.set(
          line.account_id,
          add(billedByAccount.get(line.account_id) ?? "0", line.amount),
        );
      }
      assert.equal(billedByAccount.size, 2);
      assert.equal(cmp(billedByAccount.get(liabilityA)!, july[0]!.total), 0);
      assert.equal(cmp(billedByAccount.get(liabilityB)!, august[0]!.total), 0);

      // After posting, each historical account is cleared exactly: actual GL
      // balances, not bill-line echoes.
      await submitAndReleaseIfUngated("vendor_bill", bill.documentId, actorId);
      await postDocument(bill.documentId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
      const balances = (await db.execute<{ account_id: string; balance: string }>(sql`
        select jl.account_id::text as account_id, sum(jl.amount)::text as balance
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id
         where jl.org_id = ${org.orgId} and je.status = 'posted'
           and jl.account_id in (${liabilityA}, ${liabilityB})
         group by jl.account_id`)).rows;
      // After posting, each historical account is cleared of exactly what the
      // bill remitted: actual GL balances, not bill-line echoes. The vacation
      // accrual is an internal accrual — never remitted, but posted to the
      // same liability account — so it legitimately remains payable: the
      // balance must equal precisely that remainder, which the query below
      // pins independently from the committed stub lines.
      const vacationOwed = (await db.execute<{ account_id: string; owed: string }>(sql`
        select l.liability_account_id::text as account_id, sum(l.amount)::text as owed
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_components c on c.id = l.component_id and c.org_id = l.org_id
         where l.org_id = ${org.orgId} and c.system_key = 'vacation_accrual'
           and l.liability_account_id in (${liabilityA}, ${liabilityB})
         group by l.liability_account_id`)).rows;
      assert.equal(balances.length, 2);
      assert.equal(vacationOwed.length, 2);
      for (const row of balances) {
        const owed = vacationOwed.find((v) => v.account_id === row.account_id)!.owed;
        assert.notEqual(cmp(owed, "0"), 0, "the test proves a real remainder, not a vacuous zero");
        assert.equal(
          cmp(add(row.balance, owed), "0"),
          0,
          `liability account does not clear exactly: balance ${row.balance} with ${owed} still owed`,
        );
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
