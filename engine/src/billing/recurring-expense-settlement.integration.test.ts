import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { runDueRecurringSchedules, isRecurringKindEnabled } from "./recurring.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface ExpenseOrg {
  orgId: string;
  date: string;
  subsidiaryId: string;
  employeeId: string;
  cardId: string;
  cardLiability: string;
  employeePayable: string;
  employeeReceivable: string;
  cogs: string;
}

async function setupExpenseOrg(): Promise<ExpenseOrg> {
  const org = await createScratchOrg();
  const employeePayable = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${employeePayable}, ${org.orgId}, '2110', 'Employee Reimbursements Payable', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const employeeReceivable = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${employeeReceivable}, ${org.orgId}, '1400', 'Employee Advances', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const cardLiability = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${cardLiability}, ${org.orgId}, '2050', 'Corporate Card Clearing', 'liability_card', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,employeePayable}', to_jsonb(${employeePayable}::text), true),
         '{controlAccounts,employeeReceivable}', to_jsonb(${employeeReceivable}::text), true)
     where id = ${org.orgId}`);
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'employee', 'Recurring Fieldworker', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`);
  const cardId = randomUUID();
  await db.execute(sql`
    insert into payment_cards (id, org_id, holder_party_id, liability_account_id, label, is_active)
    values (${cardId}, ${org.orgId}, ${employeeId}, ${cardLiability}, 'Recurring card', true)`);
  return {
    orgId: org.orgId,
    date: org.date,
    subsidiaryId: org.subsidiaryId,
    employeeId,
    cardId,
    cardLiability,
    employeePayable,
    employeeReceivable,
    cogs: org.accounts.cogs,
  };
}

async function seedExpenseTemplate(
  s: ExpenseOrg,
  lines: { desc: string; amount: string; settlement: string }[],
  cardId: string | null,
): Promise<string> {
  const templateId = randomUUID();
  const total = sum(lines.map((l) => l.amount));
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, currency,
      subtotal, tax_total, total, party_id, subsidiary_id, payment_card_id, created_by)
    values (${templateId}, ${s.orgId}, 'expense_report', 'draft', ${"EXPTPL-" + templateId.slice(0, 8)},
      ${s.date}, 'CAD', ${total}, '0.00', ${total}, ${s.employeeId}, ${s.subsidiaryId}, ${cardId}, null)`);
  let n = 1;
  for (const l of lines) {
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description,
        quantity, unit_price, amount, tax_amount, settlement_type)
      values (${s.orgId}, ${templateId}, ${n}, ${s.cogs}, ${l.desc},
        '1', ${l.amount}, ${l.amount}, '0', ${l.settlement})`);
    n += 1;
  }
  return templateId;
}

async function scheduleMonthly(s: ExpenseOrg, templateId: string): Promise<string> {
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into recurring_schedules (id, org_id, template_document_id, cadence, next_run_on, auto_post, is_active, created_by)
    values (${scheduleId}, ${s.orgId}, ${templateId}, 'monthly', ${s.date}, true, true, null)`);
  return scheduleId;
}

type Leg = { account_id: string; amount: string; party_id: string | null; payment_card_id: string | null; is_open_item: boolean };

async function postedLegs(docId: string, orgId: string): Promise<Leg[]> {
  return (await db.execute<Leg>(sql`
    select jl.account_id, jl.amount::text as amount, jl.party_id, jl.payment_card_id, jl.is_open_item
      from documents d join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.org_id = d.org_id
     where d.id = ${docId} and d.org_id = ${orgId}`)).rows;
}

test("recurring clone preserves company-paid settlement and funding card", { skip: !DB }, async () => {
  const s = await setupExpenseOrg();
  try {
    assert.equal(await isRecurringKindEnabled(s.orgId, "expense_report"), true);
    const templateId = await seedExpenseTemplate(s, [{ desc: "Hotel", amount: "100.00", settlement: "company_paid" }], s.cardId);
    await scheduleMonthly(s, templateId);
    const result = await runDueRecurringSchedules(s.date);
    assert.equal(result.generated, 1);
    assert.equal(result.posted, 1);
    const genId = result.documents[0]!.documentId;
    const gen = (await db.execute<{ settlement: string | null; card: string | null; status: string }>(sql`
      select l.settlement_type as settlement, d.payment_card_id as card, d.status
        from documents d join document_lines l on l.document_id = d.id and l.org_id = d.org_id
       where d.id = ${genId} and d.org_id = ${s.orgId}`)).rows[0]!;
    assert.equal(gen.settlement, "company_paid");
    assert.equal(gen.card, s.cardId);
    assert.equal(gen.status, "posted");
    const legs = await postedLegs(genId, s.orgId);
    const credit = legs.filter((l) => cmp(l.amount, "0") < 0);
    assert.equal(credit.length, 1);
    assert.equal(credit[0]!.account_id, s.cardLiability);
    assert.equal(credit[0]!.payment_card_id, s.cardId);
    assert.equal(credit[0]!.party_id, null);
    assert.equal(credit[0]!.is_open_item, false);
    assert.ok(!legs.some((l) => l.account_id === s.employeePayable), "no employee payable leg for a company-paid report");
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("recurring clone preserves a mixed settlement report per the canonical expense rule", { skip: !DB }, async () => {
  const s = await setupExpenseOrg();
  try {
    const templateId = await seedExpenseTemplate(s, [
      { desc: "Mileage", amount: "100.00", settlement: "out_of_pocket" },
      { desc: "Hotel", amount: "200.00", settlement: "company_paid" },
      { desc: "Minibar", amount: "50.00", settlement: "personal" },
    ], s.cardId);
    await scheduleMonthly(s, templateId);
    const result = await runDueRecurringSchedules(s.date);
    assert.equal(result.generated, 1);
    assert.equal(result.posted, 1);
    const genId = result.documents[0]!.documentId;
    const settlements = (await db.execute<{ settlement: string | null }>(sql`
      select settlement_type as settlement from document_lines
       where document_id = ${genId} and org_id = ${s.orgId} order by line_number`)).rows.map((r) => r.settlement);
    assert.deepEqual(settlements, ["out_of_pocket", "company_paid", "personal"]);
    const legs = await postedLegs(genId, s.orgId);
    const byAccount = new Map(legs.map((l) => [l.account_id, l]));
    const legFor = (accountId: string) => {
      const leg = byAccount.get(accountId);
      assert.ok(leg, `expected a posted leg on ${accountId}`);
      return leg;
    };
    // Out-of-pocket slice only: employee payable carries exactly 100 as an open item.
    assert.equal(cmp(legFor(s.employeePayable).amount, "-100"), 0);
    assert.equal(legFor(s.employeePayable).party_id, s.employeeId);
    assert.equal(legFor(s.employeePayable).is_open_item, true);
    // Card-funded slice: card liability carries company-paid 200 + personal 50.
    assert.equal(cmp(legFor(s.cardLiability).amount, "-250"), 0);
    assert.equal(legFor(s.cardLiability).payment_card_id, s.cardId);
    assert.equal(legFor(s.cardLiability).party_id, null);
    assert.equal(legFor(s.cardLiability).is_open_item, false);
    // Personal slice: receivable debits the full personal amount.
    assert.equal(cmp(legFor(s.employeeReceivable).amount, "50"), 0);
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("recurring clone without a funding card refuses with no generated document", { skip: !DB }, async () => {
  const s = await setupExpenseOrg();
  try {
    const templateId = await seedExpenseTemplate(s, [{ desc: "Hotel", amount: "100.00", settlement: "company_paid" }], null);
    const scheduleId = await scheduleMonthly(s, templateId);
    const result = await runDueRecurringSchedules(s.date);
    assert.equal(result.generated, 0);
    assert.equal(result.failed, 1);
    const sched = (await db.execute<{ last_error: string | null; next_run_on: string; is_active: boolean }>(sql`
      select last_error, next_run_on::text as next_run_on, is_active from recurring_schedules
       where id = ${scheduleId} and org_id = ${s.orgId}`)).rows[0]!;
    assert.match(sched.last_error ?? "", /corporate card/);
    // Scheduler atomicity: the claim rolled back (still due, still active) and
    // no document, occurrence guard row, or journal survived the refusal.
    assert.equal(sched.next_run_on, s.date);
    assert.equal(sched.is_active, true);
    assert.equal((await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${s.orgId}`)).rows[0]!.n, 1);
    assert.equal((await db.execute<{ n: number }>(sql`
      select count(*)::int as n from recurring_occurrence_documents where org_id = ${s.orgId}`)).rows[0]!.n, 0);
    assert.equal((await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_lines where org_id = ${s.orgId}`)).rows[0]!.n, 0);
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("recurring clone honors an inactive funding card exactly as a hand-entered report", { skip: !DB }, async () => {
  const s = await setupExpenseOrg();
  try {
    const templateId = await seedExpenseTemplate(s, [{ desc: "Hotel", amount: "100.00", settlement: "company_paid" }], s.cardId);
    await scheduleMonthly(s, templateId);
    // Existing policy (expense-validation): no is_active gate — deactivating a
    // card must not brick an in-flight report. The clone must behave the same.
    await db.execute(sql`update payment_cards set is_active = false where id = ${s.cardId} and org_id = ${s.orgId}`);
    const result = await runDueRecurringSchedules(s.date);
    assert.equal(result.generated, 1);
    assert.equal(result.posted, 1);
    const legs = await postedLegs(result.documents[0]!.documentId, s.orgId);
    const credit = legs.filter((l) => cmp(l.amount, "0") < 0);
    assert.deepEqual(credit.map((l) => l.account_id), [s.cardLiability]);
  } finally {
    await dropScratchOrg(s.orgId);
  }
});
