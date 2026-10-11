import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { postDocument } from "./posting-document.ts";
import { toUnits } from "../money/money.ts";
import { CashDepositError, readSaleTillWindow, readTillDropWindow, recordCashDeposit, recordTillDrop } from "./cash-deposits.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function configure(org: ScratchOrg, tillId: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = settings || jsonb_build_object('cashSales',
      coalesce(settings->'cashSales', '{}'::jsonb) ||
      jsonb_build_object('depositAccountIds', jsonb_build_array(${org.accounts.bank}::text),
                         'defaultCashAccountId', ${tillId}::text))
     where id = ${org.orgId}`));
}

/** A draft cash sale tendering `cash` to the till on `date` — not posted. */
async function draftSale(org: ScratchOrg, tillId: string, date: string, cash: string): Promise<string> {
  const saleId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, custom)
      values (${saleId}, ${org.orgId}, 'cash_sale', 'draft', ${`CS-${saleId.slice(0, 8)}`}, ${org.subsidiaryId},
              ${org.customerId}, ${date}, 'CAD', '1', ${cash}, '0', ${cash}, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_tenders
        (org_id, document_id, position, kind, method_label, account_id,
         stored_value_account_id, amount_minor, currency, reference)
      values (${org.orgId}, ${saleId}, 1, 'cash', 'cash', ${tillId}, null,
              ${toUnits(cash).toString()}, 'CAD', null)`);
  });
  return saleId;
}

async function setup(): Promise<{ org: ScratchOrg; actorId: string; tillId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Till Cashier", "cashier"));
  const tillId = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "1015", "Till Cash", "asset_current_other", org.subsidiaryId),
  );
  await configure(org, tillId);
  return { org, actorId, tillId };
}

test("a till drop records by till and date before its sales are posted, and windows reconcile", { skip: !DB }, async () => {
  const { org, actorId, tillId } = await setup();
  try {
    const firstSale = await draftSale(org, tillId, "2026-07-10", "120.0000");
    const secondSale = await draftSale(org, tillId, "2026-07-11", "80.0000");
    assert.equal(await readSaleTillWindow(org.orgId, secondSale), null, "no drop has closed the window yet");
    const before = await readTillDropWindow(org.orgId, tillId, "2026-07-12");
    assert.deepEqual(
      { after: before.after, sales: before.salesCount, tendered: before.tendered, dropped: before.dropped },
      { after: null, sales: 2, tendered: "200.0000", dropped: "0.0000" },
    );

    const first = await recordTillDrop(org.orgId, actorId, {
      tillAccountId: tillId, amount: "200.0000", date: "2026-07-12", bankAccountId: org.accounts.bank, slipNumber: "SLIP-T1",
    }, { key: randomUUID() });
    assert.equal(first.posted, true, `the drop posts though neither sale is posted: ${first.postRefusal ?? ""}`);
    assert.equal(first.window.difference, "0.0000", "the window's sales explain the drop exactly");
    const lines = (await withBypassContext(() => db.execute<{ account_id: string; amount: string }>(sql`
      select l.account_id, l.amount::text from journal_lines l
       where l.org_id = ${org.orgId} and l.entry_id = ${first.entryId}`))).rows;
    assert.ok(lines.some((line) => line.account_id === org.accounts.bank && toUnits(line.amount) === toUnits("200")), "bank debited");
    assert.ok(lines.some((line) => line.account_id === tillId && toUnits(line.amount) === toUnits("-200")), "till credited");

    const closing = await readSaleTillWindow(org.orgId, secondSale);
    assert.equal(closing?.lastSale, true, "the window's last sale carries its over/short");
    assert.equal(closing?.window.through, "2026-07-12");
    assert.equal((await readSaleTillWindow(org.orgId, firstSale))?.lastSale, false, "an earlier sale in the window does not");

    // The next window starts after the first drop: a later sale and drop
    // reconcile on their own, and an over-count needs its reason.
    await draftSale(org, tillId, "2026-07-13", "50.0000");
    await assert.rejects(
      recordTillDrop(org.orgId, actorId, {
        tillAccountId: tillId, amount: "70.0000", date: "2026-07-14", bankAccountId: org.accounts.bank, slipNumber: "SLIP-T2",
      }, { key: randomUUID() }),
      (error: unknown) => error instanceof CashDepositError && error.status === 422 && /50\.0000/.test(error.message),
    );
    const second = await recordTillDrop(org.orgId, actorId, {
      tillAccountId: tillId, amount: "70.0000", date: "2026-07-14", bankAccountId: org.accounts.bank, slipNumber: "SLIP-T2",
      reason: "Two sales from the afternoon not yet entered",
    }, { key: randomUUID() });
    assert.deepEqual(
      { after: second.window.after, sales: second.window.salesCount, tendered: second.window.tendered, dropped: second.window.dropped, difference: second.window.difference },
      { after: "2026-07-12", sales: 1, tendered: "50.0000", dropped: "70.0000", difference: "20.0000" },
    );
    const custom = (await withBypassContext(() => db.execute<{ custom: { tillDrop?: { reason?: string } } }>(sql`
      select custom from documents where org_id = ${org.orgId} and id = ${second.transferId}`))).rows[0]!.custom;
    assert.equal(custom.tillDrop?.reason, "Two sales from the afternoon not yet entered", "the count reason rides the drop");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("till drops fence the till and the destination", { skip: !DB }, async () => {
  const { org, actorId, tillId } = await setup();
  try {
    await assert.rejects(
      recordTillDrop(org.orgId, actorId, {
        tillAccountId: org.accounts.revenue, amount: "10.0000", date: "2026-07-12", bankAccountId: org.accounts.bank, slipNumber: "SLIP-X", reason: "counted float",
      }, { key: randomUUID() }),
      (error: unknown) => error instanceof CashDepositError && /no till takes cash/.test(error.message),
    );
    await assert.rejects(
      recordTillDrop(org.orgId, actorId, {
        tillAccountId: tillId, amount: "10.0000", date: "2026-07-12", bankAccountId: org.accounts.revenue, slipNumber: "SLIP-Y", reason: "counted float",
      }, { key: randomUUID() }),
      (error: unknown) => error instanceof CashDepositError && /configured deposit accounts/.test(error.message),
    );
    // A posted sale's own drop still counts in the till's window.
    const saleId = await draftSale(org, tillId, "2026-07-12", "40.0000");
    await withBypassContext(() => db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount, tax_amount, quantity, unit_price, custom)
      values (${randomUUID()}, ${org.orgId}, ${saleId}, 1, ${org.accounts.revenue}, '40', '40', '0', '1', '40', '{}'::jsonb)`));
    await withBypassContext(() => db.execute(sql`update documents set status = 'approved', posting_date = document_date where id = ${saleId} and org_id = ${org.orgId}`));
    await withOrg(org.orgId, () => postDocument(saleId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }));
    await recordCashDeposit(org.orgId, actorId, {
      saleId, amount: "40.0000", date: "2026-07-12", bankAccountId: org.accounts.bank, slipNumber: "SLIP-S",
    }, { key: randomUUID() });
    const window = await readTillDropWindow(org.orgId, tillId, "2026-07-12");
    assert.equal(window.dropped, "40.0000", "sale-linked drops leave the same till window");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
