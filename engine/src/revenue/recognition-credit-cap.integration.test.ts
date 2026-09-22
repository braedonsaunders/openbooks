import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runRevenueRecognition } from "./recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * F-w5-001: revenue re-inflated after a credit memo.
 *
 * An invoice carrying a recognition rule cannot be voided (document-void
 * refuses and points at a cancellation workflow with no route), so the only
 * operator path is a manual credit memo. The memo unwinds AR and deferred,
 * but the obligation stays open with its unposted plan lines intact — and the
 * next recognition run posts them anyway, re-inflating earned revenue and
 * driving deferred past zero.
 *
 * Rule pinned here: a recognition run must never post more than what remains
 * genuinely unearned —
 *   remaining = allocated − recognized(net) − credited-to-deferred,
 * where credited-to-deferred counts only posted, non-voided customer-credit
 * lines that debit the obligation's own deferred account on a credit applied
 * to the source invoice. A credit that debits an income account (a commercial
 * concession while service continues) must NOT touch the plan.
 */

/** Provision every month covered by the service item's 12-month term. */
async function seedRecognitionTermPeriods(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
): Promise<void> {
  const calendar = await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id
      from accounting_periods
     where id = ${org.periodId} and org_id = ${org.orgId}
  `);
  const fiscalCalendarId = calendar.rows[0]?.fiscal_calendar_id;
  assert.ok(fiscalCalendarId);
  const periods = [
    [2026, 8, "2026-08-01", "2026-08-31"],
    [2026, 9, "2026-09-01", "2026-09-30"],
    [2026, 10, "2026-10-01", "2026-10-31"],
    [2026, 11, "2026-11-01", "2026-11-30"],
    [2026, 12, "2026-12-01", "2026-12-31"],
    [2027, 1, "2027-01-01", "2027-01-31"],
    [2027, 2, "2027-02-01", "2027-02-28"],
    [2027, 3, "2027-03-01", "2027-03-31"],
    [2027, 4, "2027-04-01", "2027-04-30"],
    [2027, 5, "2027-05-01", "2027-05-31"],
    [2027, 6, "2027-06-01", "2027-06-30"],
  ] as const;
  for (const [fiscalYear, periodNumber, startsOn, endsOn] of periods) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (${randomUUID()}, ${org.orgId}, ${fiscalCalendarId}, ${fiscalYear},
              ${periodNumber}, ${startsOn.slice(0, 7)}, ${startsOn}, ${endsOn},
              false, '{}'::jsonb)
    `);
  }
}

async function glBalance(orgId: string, accountId: string): Promise<string> {
  const r = await db.execute<{ balance: string }>(sql`
    select coalesce(sum(line.amount), 0)::text as balance
      from journal_lines line
      join journal_entries entry on entry.id = line.entry_id
     where line.org_id = ${orgId}
       and line.account_id = ${accountId}
       and entry.status = 'posted'
  `);
  return r.rows[0]!.balance;
}

async function postInvoice(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  adminId: string,
  documentNumber: string,
): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, due_date, currency, fx_rate, status,
       subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
       created_by, updated_by)
    values
      (${documentId}, ${org.orgId}, 'customer_invoice', ${documentNumber},
       ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
       ${org.date}, 'CAD', 1, 'draft', 1200, 0, 1200, false,
       '{}'::jsonb, '{}'::jsonb, ${adminId}, ${adminId})
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, custom, tax_overridden,
       extra_dims, created_by, updated_by)
    values
      (${randomUUID()}, ${org.orgId}, ${documentId}, 1,
       ${org.items.service}, ${org.accounts.revenue}, 1, 1200, 1200, 0,
       false, 0, 0, '{}'::jsonb, false, '{}'::jsonb,
       ${adminId}, ${adminId})
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', updated_at = now()
     where id = ${documentId} and org_id = ${org.orgId}
  `);
  await postDocument(
    documentId,
    {
      control: {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      },
    },
    { audit: { actorId: adminId, source: "test" } },
  );
  return documentId;
}

/**
 * Post a manual credit memo for `amount` whose income line debits
 * `debitAccountId` (deferred for unearned relief, income for a concession),
 * then apply it in full to the invoice. Mirrors the operator path from
 * F-w5-001: the memo is a standalone document settled against the invoice
 * through open-item application.
 */
async function postAndApplyCredit(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  adminId: string,
  invoiceId: string,
  documentNumber: string,
  amount: string,
  debitAccountId: string,
  appliedAmount = amount,
): Promise<string> {
  const creditId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, due_date, currency, fx_rate, status,
       subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
       created_by, updated_by)
    values
      (${creditId}, ${org.orgId}, 'customer_credit', ${documentNumber},
       ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
       ${org.date}, 'CAD', 1, 'draft', ${amount}, 0, ${amount}, false,
       '{}'::jsonb, '{}'::jsonb, ${adminId}, ${adminId})
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, custom, tax_overridden,
       extra_dims, created_by, updated_by)
    values
      (${randomUUID()}, ${org.orgId}, ${creditId}, 1,
       ${org.items.service}, ${debitAccountId}, 1, ${amount}, ${amount}, 0,
       false, 0, 0, '{}'::jsonb, false, '{}'::jsonb,
       ${adminId}, ${adminId})
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', updated_at = now()
     where id = ${creditId} and org_id = ${org.orgId}
  `);
  await postDocument(
    creditId,
    {
      control: {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      },
    },
    { audit: { actorId: adminId, source: "test" } },
  );
  const creditEntry = (
    await db.execute<{ posted_entry_id: string }>(sql`
      select posted_entry_id from documents
       where id = ${creditId} and org_id = ${org.orgId}
    `)
  ).rows[0]!.posted_entry_id;
  const invoiceEntry = (
    await db.execute<{ posted_entry_id: string }>(sql`
      select posted_entry_id from documents
       where id = ${invoiceId} and org_id = ${org.orgId}
    `)
  ).rows[0]!.posted_entry_id;
  const fromLine = (
    await db.execute<{ id: string }>(sql`
      select id from journal_lines
       where entry_id = ${creditEntry} and org_id = ${org.orgId}
         and account_id = ${org.accounts.ar}
    `)
  ).rows[0]!.id;
  const toLine = (
    await db.execute<{ id: string }>(sql`
      select id from journal_lines
       where entry_id = ${invoiceEntry} and org_id = ${org.orgId}
         and account_id = ${org.accounts.ar}
    `)
  ).rows[0]!.id;
  await db.execute(sql`
    insert into applications
      (org_id, from_line_id, to_line_id, amount, applied_on, source_amount,
       source_transaction_amount, source_transaction_currency,
       target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference,
       created_by, updated_by)
    values (${org.orgId}, ${fromLine}, ${toLine}, ${appliedAmount}, ${org.date},
       ${appliedAmount}, ${appliedAmount}, 'CAD', ${appliedAmount}, 'CAD',
       '1', 'same_currency', 'REVENUE-CREDIT-CAP-TEST', ${adminId}, ${adminId})
  `);
  return creditId;
}

test(
  "a full-remainder credit to deferred stops all further recognition",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actors = await seedFlowActors(org.orgId);
    try {
      await seedRecognitionTermPeriods(org);
      const invoiceId = await postInvoice(org, actors.adminId, "INV-CAP-FULL");

      // Recognize Jul–Sep: 300 earned, 900 still deferred.
      const first = await runRevenueRecognition(org.orgId, "2026-09-30", actors.adminId);
      assert.equal(first.posted, 3);
      assert.equal(first.totalAmount, "300.0000");

      // Operator credits the full 900 remainder to deferred and applies it.
      await postAndApplyCredit(org, actors.adminId, invoiceId, "CM-CAP-FULL", "900", org.accounts.deferred);

      // GL exact at this point: earned 300, deferred fully unwound.
      assert.equal(await glBalance(org.orgId, org.accounts.recognized), "-300.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.deferred), "0.0000");

      // The scoped run must post nothing: every remaining plan line is
      // genuinely earned-zero. Before the fix it posts 9 lines (900.0000),
      // re-inflating earned 300 -> 1200 and driving deferred 900 past zero.
      const rerun = await runRevenueRecognition(org.orgId, "2027-06-30", actors.adminId);
      assert.equal(rerun.posted, 0);
      assert.equal(await glBalance(org.orgId, org.accounts.recognized), "-300.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.deferred), "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a partial credit to deferred caps recognition at what remains unearned",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actors = await seedFlowActors(org.orgId);
    try {
      await seedRecognitionTermPeriods(org);
      const invoiceId = await postInvoice(org, actors.adminId, "INV-CAP-PART");

      const first = await runRevenueRecognition(org.orgId, "2026-09-30", actors.adminId);
      assert.equal(first.posted, 3);

      // Credit half the 900 remainder: 450 genuinely unearned remains.
      await postAndApplyCredit(org, actors.adminId, invoiceId, "CM-CAP-PART", "450", org.accounts.deferred);
      assert.equal(await glBalance(org.orgId, org.accounts.deferred), "-450.0000");

      // Must post exactly 450 more — never the full 900 plan, and never zero
      // (an over-eager fix that retires the whole plan on any credit).
      const rerun = await runRevenueRecognition(org.orgId, "2027-06-30", actors.adminId);
      assert.equal(rerun.totalAmount, "450.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.recognized), "-750.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.deferred), "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an uncredited invoice recognizes in full (control: no behavior change)",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actors = await seedFlowActors(org.orgId);
    try {
      await seedRecognitionTermPeriods(org);
      await postInvoice(org, actors.adminId, "INV-CAP-CTRL");

      const first = await runRevenueRecognition(org.orgId, "2026-09-30", actors.adminId);
      assert.equal(first.posted, 3);
      const rerun = await runRevenueRecognition(org.orgId, "2027-06-30", actors.adminId);
      assert.equal(rerun.posted, 9);
      assert.equal(rerun.totalAmount, "900.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.recognized), "-1200.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.deferred), "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a credit to income (concession while service continues) does not touch the plan",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actors = await seedFlowActors(org.orgId);
    try {
      await seedRecognitionTermPeriods(org);
      const invoiceId = await postInvoice(org, actors.adminId, "INV-CAP-CONC");

      const first = await runRevenueRecognition(org.orgId, "2026-09-30", actors.adminId);
      assert.equal(first.posted, 3);

      // 100 service concession: debits income directly, service continues.
      await postAndApplyCredit(org, actors.adminId, invoiceId, "CM-CAP-CONC", "100", org.accounts.revenue);

      // The full remaining plan still posts: earned nets 300 − 100 + 900.
      const rerun = await runRevenueRecognition(org.orgId, "2027-06-30", actors.adminId);
      assert.equal(rerun.posted, 9);
      assert.equal(rerun.totalAmount, "900.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.recognized), "-1200.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.deferred), "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test('credits follow prospective reallocation into an added promise rather than being lost with its missing invoice line', {skip:!DB}, async()=>{
 const org=await createScratchOrg();
 try {
  const actors=await seedFlowActors(org.orgId);
  await seedRecognitionTermPeriods(org);
  const invoiceId=await postInvoice(org,actors.adminId,'INV-AMENDED-CREDIT');
  const first=await runRevenueRecognition(org.orgId,'2026-09-30',actors.adminId);assert.equal(first.totalAmount,'300.0000');
  const original=(await db.execute<{id:string;contract_id:string}>(sql`select o.id,o.contract_id from performance_obligations o join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id where o.org_id=${org.orgId} and dl.document_id=${invoiceId}`)).rows[0]!;
  const {proposeRevenueModification,applyRevenueModification}=await import('./contract-modifications.ts');
  const {submitFinancialChange}=await import('../flows/financial-changes-adapter.ts');
  const {seedApprovalFlow}=await import('../testing/fixtures.ts');
  const {decideGate}=await import('../flows/gates.ts');
  await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.submitterId},'ar.post','grant')`);
  await seedApprovalFlow(org.orgId,{subjectKind:'financial_change',assignees:[{type:'user',userId:actors.approver1Id}],mode:'any',preventSelfApproval:false});
  const promise={description:'Remaining promise',standaloneSellingPrice:'450',recognitionRuleId:org.recognitionRuleId,recognitionEndsOn:'2027-06-30',percentComplete:'25',deferredAccountId:org.accounts.deferred,recognizedAccountId:org.accounts.recognized};
  const {changeId}=await proposeRevenueModification(org.orgId,original.contract_id,actors.submitterId,{effectiveOn:'2026-10-01',reason:'Reallocate distinct remaining service without new consideration',idempotencyKey:randomUUID(),subsidiaryId:org.subsidiaryId,enforceableRightsEvidence:'Both parties signed the changed service scope',assessment:'Two equally priced remaining promises; unchanged CAD recognition basis',bookRates:[{bookId:org.bookId,fxRate:'1'}],groups:[{treatment:'prospective',existingObligationIds:[original.id],considerationChange:'0',remainingDistinct:true,additionsAtStandalonePrice:false,promises:[{...promise,existingId:original.id},{...promise,description:'New replacement promise',percentComplete:'0'}]}]});
  await submitFinancialChange(org.orgId,changeId,actors.submitterId);
  const gate=(await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${changeId} and status='pending'`)).rows[0]!;
  await decideGate({gateId:gate.id,userId:actors.approver1Id,decision:'approved'});
  const applied=await applyRevenueModification(org.orgId,changeId,actors.submitterId);assert.equal((applied.obligationIds as string[]).length,2);
  await postAndApplyCredit(org,actors.adminId,invoiceId,'CM-AMENDED-CREDIT','900',org.accounts.deferred);
  const after=await runRevenueRecognition(org.orgId,'2027-06-30',actors.adminId);assert.equal(after.posted,0);assert.equal(await glBalance(org.orgId,org.accounts.recognized),'-300.0000');assert.equal(await glBalance(org.orgId,org.accounts.deferred),'0.0000');
 } finally {await dropScratchOrg(org.orgId)}
});

for (const scenario of [
  { title: "a full-remainder credit", applied: "900", earned: "300.0000", additional: "0.0000", mirror: false },
  { title: "a partial application", applied: "300", earned: "900.0000", additional: "1200.0000", mirror: false },
  { title: "one credit with a secondary GL representation", applied: "300", earned: "900.0000", additional: "1200.0000", mirror: true },
]) {
  test(`${scenario.title} caps every recognition book using one settlement source`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const secondBook = randomUUID();
      await db.execute(sql`insert into accounting_books (id,org_id,code,name,is_primary,is_active,posts_gl)
        values (${secondBook},${org.orgId},'TAX','Tax book',false,true,true)`);
      await seedRecognitionTermPeriods(org);
      const invoiceId = await postInvoice(org, actors.adminId, "INV-BOOK-CREDIT");
      const first = await runRevenueRecognition(org.orgId, "2026-09-30", actors.adminId);
      assert.equal(first.posted, 6, "each book recognizes its first three periods");
      const creditId = await postAndApplyCredit(org, actors.adminId, invoiceId,
        "CM-BOOK-CREDIT", "900", org.accounts.deferred, scenario.applied);
      if (scenario.mirror) {
        // A second GL representation must not become a second commercial credit.
        await db.transaction(async tx => {
          const mirrorId = randomUUID();
          await tx.execute(sql`insert into journal_entries
            (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id,created_by)
            values (${mirrorId},${org.orgId},${secondBook},${org.subsidiaryId},${`CM-TAX-${mirrorId}`},
              ${org.date},${org.periodId},'draft','manual',${creditId},${actors.adminId})`);
          await tx.execute(sql`insert into journal_lines
            (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id)
            select l.org_id,${mirrorId},l.line_number,l.account_id,l.subsidiary_id,l.amount,l.currency,l.txn_amount,l.fx_rate,l.party_id
            from journal_lines l join documents d on d.posted_entry_id=l.entry_id and d.org_id=l.org_id
            where d.id=${creditId} and d.org_id=${org.orgId}`);
          await tx.execute(sql`update journal_entries set status='posted',posted_by=${actors.adminId}
            where id=${mirrorId} and org_id=${org.orgId}`);
        });
      }
      const after = await runRevenueRecognition(org.orgId, "2027-06-30", actors.adminId);
      assert.equal(toUnits(after.totalAmount), toUnits(scenario.additional));
      const balances = (await db.execute<{ book_id: string; amount: string }>(sql`
        select e.book_id,sum(l.amount)::text as amount from journal_lines l
        join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
        where l.org_id=${org.orgId} and l.account_id=${org.accounts.recognized}
          and e.status in ('posted','reversed') group by e.book_id`)).rows;
      assert.deepEqual(new Set(balances.map(r => r.book_id)), new Set([org.bookId, secondBook]));
      // The set comparison above rides an inline map, so pin the row count
      // directly: both books must have posted, or the loop proves nothing.
      assert.equal(balances.length, 2);
      for (const row of balances) assert.equal(row.amount, `-${scenario.earned}`, `earned balance in book ${row.book_id}`);
      const replay = await runRevenueRecognition(org.orgId, "2027-06-30", actors.adminId);
      assert.equal(replay.posted, 0, "held plans cannot release additional revenue on replay");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
