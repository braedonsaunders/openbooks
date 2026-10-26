/**
 * 0008 maintains each open-item line's live remaining amount. Posting creates
 * the row at the line's magnitude, applications and their one-time unapply
 * move it, and the as-of open-item reader still answers every date exactly:
 * a document settled after the date is open on it, and an application
 * unapplied after the date still counts on it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/database";
import { postDocument } from "@openbooks/engine/documents";
import { assertDedicatedFixtureDatabase, createScratchOrg, createScratchUser, type ScratchOrg } from "@openbooks/engine/testing/fixtures";
import { openItems } from "../../../web/lib/cash/open-items";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function postReceivable(org: ScratchOrg, actor: string, kind: "customer_invoice" | "customer_payment", amount: string, date: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, ${kind}, 'draft', ${id}, ${org.subsidiaryId}, ${org.customerId}, ${date},
      ${kind === "customer_invoice" ? date : null}, 'CAD', 1, ${amount}, 0, ${amount}, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${kind === "customer_invoice" ? org.accounts.revenue : org.accounts.bank}, 1, ${amount}, ${amount}, 0, ${amount})`);
  await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${id}`);
  await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  return id;
}

async function arLine(org: ScratchOrg, documentId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    select jl.id from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${org.orgId} and je.source_document_id = ${documentId} and jl.account_id = ${org.accounts.ar}`, "objects");
  assert.equal(rows.length, 1);
  return rows[0]!.id;
}

async function remainingOf(org: ScratchOrg, lineId: string): Promise<string | null> {
  const rows = await db.execute<{ remaining: string }>(sql`
    select remaining::text as remaining from open_item_balances where org_id = ${org.orgId} and line_id = ${lineId}`, "objects");
  return rows[0]?.remaining ?? null;
}

async function assertSound(org: ScratchOrg, step: string) {
  const drift = await db.execute(sql`select * from openbooks_open_item_balances_verify(${org.orgId})`, "objects");
  assert.deepEqual(drift, [], `open-item balances agree with their source after ${step}`);
}

async function openOn(org: ScratchOrg, asOf: string): Promise<Map<string, string>> {
  const items = await withOrgContext(org.orgId, () => openItems(org.orgId, "ar", asOf));
  return new Map(items.map((item) => [String(item.docId), String(item.remaining)]));
}

test("open-item balances follow postings, applications and unapplies, and as-of reads stay exact", { skip: !DB, timeout: 180_000 }, async () => {
  await assertDedicatedFixtureDatabase();
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, "Receivables", "admin"));
  const calendarId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${org.orgId} limit 1`, "objects")))[0]!.id;
  await withBypassContext(async () => {
    for (const [n, from, to] of [[5, "2026-05-01", "2026-05-31"], [6, "2026-06-01", "2026-06-30"], [7, "2026-07-01", "2026-07-31"]] as const) {
      // The scratch calendar may already declare some of these months.
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        select ${randomUUID()}, ${org.orgId}, 2026, ${n}, ${`2026-0${n}`}, ${from}::date, ${to}::date, false, ${calendarId}
         where not exists (select 1 from accounting_periods
                            where org_id = ${org.orgId} and fiscal_calendar_id = ${calendarId}
                              and fiscal_year = 2026 and period_number = ${n})`);
    }
  });

  const { settled, open, payment, settledLine, paymentLine } = await withBypassContext(async () => {
    const settled = await postReceivable(org, actor, "customer_invoice", "1000.0000", "2026-05-10");
    const open = await postReceivable(org, actor, "customer_invoice", "500.0000", "2026-05-12");
    const payment = await postReceivable(org, actor, "customer_payment", "1000.0000", "2026-06-20");
    return { settled, open, payment, settledLine: await arLine(org, settled), paymentLine: await arLine(org, payment) };
  });

  await withBypassContext(async () => {
    assert.equal(await remainingOf(org, settledLine), "1000.0000", "a posted open-item line starts at its magnitude");
    await assertSound(org, "posting");
    await db.execute(sql`insert into applications
      (org_id, from_line_id, to_line_id, amount, applied_on, source_amount, source_transaction_amount,
       source_transaction_currency, target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference, created_by, updated_by)
      values (${org.orgId}, ${paymentLine}, ${settledLine}, '1000.0000', '2026-06-20', '1000.0000', '1000.0000', 'CAD',
        '1000.0000', 'CAD', '1', 'same_currency', 'open-item-balance-test', ${actor}, ${actor})`);
    assert.equal(await remainingOf(org, settledLine), "0.0000", "the applied target leg settles the invoice line");
    if (await remainingOf(org, paymentLine) !== null) {
      assert.equal(await remainingOf(org, paymentLine), "0.0000", "the applied source leg consumes the payment line");
    }
    await assertSound(org, "applying a payment");
  });

  let after = await openOn(org, "2026-06-25");
  assert.equal(after.has(settled), false, "settled on 2026-06-20, the invoice is closed on 2026-06-25");
  assert.equal(after.get(open), "500.0000");
  const before = await openOn(org, "2026-06-19");
  assert.equal(before.get(settled), "1000.0000", "a document settled after the date is open on the date");
  assert.equal(before.get(open), "500.0000");
  assert.equal(before.has(payment), false, "payments are not receivable documents");

  await withBypassContext(async () => {
    await db.execute(sql`update applications set unapplied_at = '2026-07-05T12:00:00Z', updated_by = ${actor}
      where org_id = ${org.orgId} and to_line_id = ${settledLine}`);
    assert.equal(await remainingOf(org, settledLine), "1000.0000", "an unapply restores the live remaining");
    await assertSound(org, "unapplying");
  });

  after = await openOn(org, "2026-06-25");
  assert.equal(after.has(settled), false, "unapplied only on 2026-07-05, the application still counts on 2026-06-25");
  const reopened = await openOn(org, "2026-07-10");
  assert.equal(reopened.get(settled), "1000.0000", "after the unapply the invoice is open again");

  await withBypassContext(async () => {
    const before = await db.execute<{ n: number }>(sql`select count(*)::int as n from open_item_balances where org_id = ${org.orgId}`, "objects");
    const rebuilt = await db.execute<{ n: string }>(sql`select openbooks_open_item_balances_rebuild(${org.orgId})::text as n`, "objects");
    assert.equal(Number(rebuilt[0]!.n), before[0]!.n, "a rebuild reproduces one row per open-item line");
    await assertSound(org, "a rebuild");
  });
});
