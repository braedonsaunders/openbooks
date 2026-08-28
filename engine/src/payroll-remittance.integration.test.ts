import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, sum } from "./money.ts";
import { postDocument } from "./posting.ts";
import { recordPayRunPayment } from "./payroll-payment.ts";
import { createRemittanceBill, payrollRemittanceSummary } from "./payroll-remittance.ts";
import { calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { t4Slips, t4Summary } from "./payroll-yearend.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

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
