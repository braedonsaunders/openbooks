import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { postDocument } from "./posting-document.ts";
import { CashDepositError, recordCashDeposit } from "./cash-deposits.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const control = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function configureDeposits(orgId: string, bankIds: string[]): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = settings || jsonb_build_object('cashSales',
      coalesce(settings->'cashSales', '{}'::jsonb) ||
      jsonb_build_object('depositAccountIds',
        (select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements_text(${JSON.stringify(bankIds)}::jsonb) as value)))
     where id = ${orgId}`));
}

interface DropFixture {
  org: ScratchOrg;
  actorId: string;
  saleId: string;
  saleNumber: string;
  tillId: string;
}

async function fixture(cashTendered: string): Promise<DropFixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Till Cashier", "cashier"));
  const tillId = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "1015", "Till Cash", "asset_current_other", org.subsidiaryId),
  );
  await configureDeposits(org.orgId, [org.accounts.bank]);
  const saleId = randomUUID();
  const saleNumber = `CS-DROP-${cashTendered.replace(".", "")}`;
  await withBypassContext(() =>
    db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom)
      values (${saleId}, ${org.orgId}, 'cash_sale', 'draft', ${saleNumber}, ${org.subsidiaryId},
              ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1',
              ${cashTendered}, '0', ${cashTendered}, '{}'::jsonb)`),
  );
  await withBypassContext(() =>
    db.execute(sql`
      insert into document_tenders
        (org_id, document_id, position, kind, method_label, account_id,
         stored_value_account_id, amount_minor, currency, reference)
      values (${org.orgId}, ${saleId}, 1, 'cash', 'cash', ${tillId}, null,
              ${toUnits(cashTendered).toString()}, 'CAD', null)`),
  );
  await withBypassContext(() =>
    db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, quantity, unit_price, custom)
      values (${randomUUID()}, ${org.orgId}, ${saleId}, 1, ${org.accounts.revenue},
              ${cashTendered}, ${cashTendered}, '0', '1', ${cashTendered}, '{}'::jsonb)`),
  );
  await withBypassContext(() =>
    db.execute(sql`update documents set status = 'approved' where id = ${saleId} and org_id = ${org.orgId}`),
  );
  await withOrg(org.orgId, () => postDocument(saleId, control(org)));
  return { org, actorId, saleId, saleNumber, tillId };
}

test("a till drop posts a transfer from till cash to the bank", { skip: !DB }, async () => {
  const { org, actorId, saleId, saleNumber, tillId } = await fixture("100.0000");
  try {
    const drop = await recordCashDeposit(
      org.orgId,
      actorId,
      { saleId, amount: "60.0000", date: org.date, bankAccountId: org.accounts.bank, slipNumber: "SLIP-1" },
      { key: randomUUID() },
    );
    assert.equal(drop.posted, true);
    assert.ok(drop.entryId);
    const legs = (await db.execute<{ number: string | null; amount: string }>(sql`
      select a.number, l.amount::text as amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where e.org_id = ${org.orgId} and e.source_document_id = ${drop.transferId}
       order by l.line_number`)).rows;
    assert.deepEqual(
      legs.map((leg) => [leg.number, leg.amount]),
      [
        ["1000", "60.0000"],
        ["1015", "-60.0000"],
      ],
    );
    const link = (await db.execute<{ link: unknown }>(sql`
      select custom->'cashSaleDeposit' as link from documents
       where org_id = ${org.orgId} and id = ${drop.transferId}`)).rows[0]?.link;
    assert.deepEqual(link, { saleId, slipNumber: "SLIP-1" });
    // The lifetime cap counts the posted drop: 40.00 remains.
    await assert.rejects(
      recordCashDeposit(
        org.orgId,
        actorId,
        { saleId, amount: "50.0000", date: org.date, bankAccountId: org.accounts.bank, slipNumber: "SLIP-2" },
        {},
      ),
      (error: unknown) =>
        error instanceof CashDepositError &&
        error.status === 422 &&
        /exceeds cash sale .*'s undropped till cash 40\.0000/.test(error.message),
    );
    void saleNumber;
    void tillId;
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a replayed drop key returns the same posted transfer", { skip: !DB }, async () => {
  const { org, actorId, saleId } = await fixture("100.0000");
  try {
    const key = randomUUID();
    const first = await recordCashDeposit(
      org.orgId,
      actorId,
      { saleId, amount: "25.0000", date: org.date, bankAccountId: org.accounts.bank, slipNumber: "SLIP-9" },
      { key },
    );
    const second = await recordCashDeposit(
      org.orgId,
      actorId,
      { saleId, amount: "25.0000", date: org.date, bankAccountId: org.accounts.bank, slipNumber: "SLIP-9" },
      { key },
    );
    assert.equal(first.transferId, second.transferId);
    assert.equal(second.posted, true);
    const count = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from documents
       where org_id = ${org.orgId} and kind = 'transfer' and status <> 'voided'`)).rows[0]?.n;
    assert.equal(count, "1");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("drops refuse without configured deposit accounts", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Till Cashier", "cashier"));
    const tillId = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "1015", "Till Cash", "asset_current_other", org.subsidiaryId),
    );
    const saleId = randomUUID();
    await withBypassContext(() =>
      db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom)
        values (${saleId}, ${org.orgId}, 'cash_sale', 'draft', 'CS-NOCFG', ${org.subsidiaryId},
                ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1',
                '50.0000', '0', '50.0000', '{}'::jsonb)`),
    );
    await withBypassContext(() =>
      db.execute(sql`
        insert into document_tenders
          (org_id, document_id, position, kind, method_label, account_id,
           stored_value_account_id, amount_minor, currency, reference)
        values (${org.orgId}, ${saleId}, 1, 'cash', 'cash', ${tillId}, null, '500000', 'CAD', null)`),
    );
    await withBypassContext(() =>
      db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
           tax_amount, quantity, unit_price, custom)
        values (${randomUUID()}, ${org.orgId}, ${saleId}, 1, ${org.accounts.revenue},
                '50.0000', '50.0000', '0', '1', '50.0000', '{}'::jsonb)`),
    );
    await withBypassContext(() =>
      db.execute(sql`update documents set status = 'approved' where id = ${saleId} and org_id = ${org.orgId}`),
    );
    await withOrg(org.orgId, () => postDocument(saleId, control(org)));
    await assert.rejects(
      recordCashDeposit(
        org.orgId,
        actorId,
        { saleId, amount: "10.0000", date: org.date, bankAccountId: org.accounts.bank, slipNumber: "SLIP-X" },
        {},
      ),
      (error: unknown) =>
        error instanceof CashDepositError &&
        error.status === 409 &&
        /Till drops are not configured/.test(error.message) &&
        /Company Settings/.test(error.remedy),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("drops refuse an unposted sale, a missing slip and an outside bank", { skip: !DB }, async () => {
  const { org, actorId, saleId } = await fixture("100.0000");
  try {
    const draftId = randomUUID();
    await withBypassContext(() =>
      db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom)
        values (${draftId}, ${org.orgId}, 'cash_sale', 'draft', 'CS-DRAFT', ${org.subsidiaryId},
                ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1',
                '10.0000', '0', '10.0000', '{}'::jsonb)`),
    );
    await assert.rejects(
      recordCashDeposit(
        org.orgId,
        actorId,
        { saleId: draftId, amount: "10.0000", date: org.date, bankAccountId: org.accounts.bank, slipNumber: "S" },
        {},
      ),
      (error: unknown) =>
        error instanceof CashDepositError &&
        error.status === 422 &&
        /Post the cash sale first/.test(error.remedy),
    );
    await assert.rejects(
      recordCashDeposit(
        org.orgId,
        actorId,
        { saleId, amount: "10.0000", date: org.date, bankAccountId: org.accounts.bank, slipNumber: "  " },
        {},
      ),
      (error: unknown) =>
        error instanceof CashDepositError && error.status === 422 && /slip number/.test(error.message),
    );
    const outside = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "1020", "Outside Bank", "asset_bank", org.subsidiaryId),
    );
    await assert.rejects(
      recordCashDeposit(
        org.orgId,
        actorId,
        { saleId, amount: "10.0000", date: org.date, bankAccountId: outside, slipNumber: "S-3" },
        {},
      ),
      (error: unknown) =>
        error instanceof CashDepositError &&
        error.status === 422 &&
        /outside this organization's configured deposit accounts/.test(error.message),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
