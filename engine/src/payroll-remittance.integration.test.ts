import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, sum } from "./money.ts";
import { postDocument } from "./posting.ts";
import { recordPayRunPayment } from "./payroll-payment.ts";
import {
  createRemittanceBill,
  payrollRemittanceSummary,
  remittanceFenceLockKey,
} from "./payroll-remittance.ts";
import { calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { t4Slips, t4Summary } from "./payroll-yearend.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

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
  input: { payDate: string; amount: string; employeeId?: string },
): Promise<void> {
  const { org, actorId, componentId, scheduleId } = fixture;
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
       created_by, updated_by)
    values
      (${lineId}, ${org.orgId}, ${stubId}, ${componentId}, 'deduction',
       'Test withholding', ${input.amount}, 10, ${actorId}, ${actorId})`);
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
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'salary', 1, 1,
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
      const billDoc = ((await db.execute<Record<string, any>>(sql`
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
      const payment = await recordPayRunPayment({
        orgId: org.orgId, actorId, documentId: run.documentId, bankAccountId: org.accounts.bank,
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
  "remittance bill snapshots accruals after the destination fence is released",
  { skip: !DB },
  async () => {
    const fixture = await createRemittanceFixture();
    const key = remittanceFenceLockKey(fixture.org.orgId, {
      partyId: fixture.org.vendorId, filingAccountId: null,
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
