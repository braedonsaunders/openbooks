import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { postDocument } from "./posting-document.ts";
import { toUnits } from "../money/money.ts";
import {
  CashDepositError,
  readSaleTillWindow,
  readTillDropWindow,
  recordCashDeposit,
  recordTillDrop,
} from "./cash-deposits.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function configure(org: ScratchOrg, tillId: string): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
    update orgs set settings = jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"cashSales":true}'::jsonb) || jsonb_build_object('cashSales',
      coalesce(settings->'cashSales', '{}'::jsonb) ||
      jsonb_build_object('depositAccountIds', jsonb_build_array(${org.accounts.bank}::text),
                         'defaultCashAccountId', ${tillId}::text))
     where id = ${org.orgId}`),
  );
}

/** A draft cash sale tendering `cash` to the till on `date` — not posted. */
async function draftSale(
  org: ScratchOrg,
  tillId: string,
  date: string,
  cash: string,
  subsidiaryId = org.subsidiaryId,
  currency = "CAD",
): Promise<string> {
  const saleId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, custom)
      values (${saleId}, ${org.orgId}, 'cash_sale', 'draft', ${`CS-${saleId.slice(0, 8)}`}, ${subsidiaryId},
              ${org.customerId}, ${date}, ${currency}, '1', ${cash}, '0', ${cash}, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_tenders
        (org_id, document_id, position, kind, method_label, account_id,
         stored_value_account_id, amount_minor, currency, reference)
      values (${org.orgId}, ${saleId}, 1, 'cash', 'cash', ${tillId}, null,
              ${toUnits(cash).toString()}, ${currency}, null)`);
  });
  return saleId;
}

async function setup(): Promise<{ org: ScratchOrg; actorId: string; tillId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Till Cashier", "cashier"),
  );
  const tillId = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "1015", "Till Cash", "asset_current_other", org.subsidiaryId),
  );
  await configure(org, tillId);
  return { org, actorId, tillId };
}

test(
  "shared till accounts retain independent entity windows and refuse hidden or empty reader scope",
  { skip: !DB },
  async () => {
    const { org, actorId, tillId } = await setup();
    const branchId = randomUUID();
    try {
      await withBypassContext(async () => {
        await db.execute(sql`insert into subsidiaries(id,org_id,name,parent_id,base_currency,country,is_active,is_elimination,custom)
        values(${branchId},${org.orgId},'Second till entity',${org.subsidiaryId},'CAD','CA',true,false,'{}'::jsonb)`);
        await db.execute(
          sql`update accounts set subsidiary_id=null where org_id=${org.orgId} and id=${tillId}`,
        );
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,multiSubsidiary}','true'::jsonb)
        where id=${org.orgId}`);
      });
      const rootSale = await draftSale(org, tillId, "2026-07-10", "120.0000");
      await draftSale(org, tillId, "2026-07-11", "900.0000", branchId);
      const branchDrop = await recordTillDrop(
        org.orgId,
        actorId,
        {
          tillAccountId: tillId,
          amount: "900.0000",
          date: "2026-07-11",
          bankAccountId: org.accounts.bank,
          slipNumber: "BRANCH-DROP",
          subsidiaryId: branchId,
        },
        { key: randomUUID(), allowedSubsidiaryIds: new Set([branchId]) },
      );
      assert.equal(branchDrop.window.subsidiaryId, branchId);
      assert.equal(branchDrop.window.tendered, "900.0000");
      assert.equal(branchDrop.window.dropped, "900.0000");
      const scope = {
        subsidiaryId: org.subsidiaryId,
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      };
      const rootWindow = await readTillDropWindow(org.orgId, tillId, "2026-07-12", scope);
      assert.equal(rootWindow.after, null, "another entity cannot establish this entity's cutoff");
      assert.equal(rootWindow.salesCount, 1);
      assert.equal(rootWindow.tendered, "120.0000");
      assert.equal(rootWindow.dropped, "0.0000");
      for (const denied of [
        { ...scope, subsidiaryId: branchId },
        { ...scope, allowedSubsidiaryIds: new Set<string>() },
        { allowedSubsidiaryIds: null },
      ])
        await assert.rejects(
          readTillDropWindow(org.orgId, tillId, "2026-07-12", denied),
          (error: unknown) => error instanceof CashDepositError && error.status === 404,
        );
      await assert.rejects(
        readTillDropWindow(org.orgId, randomUUID(), "2026-07-12", scope),
        (error: unknown) => error instanceof CashDepositError && error.status === 404,
      );
      const rootDrop = await recordTillDrop(
        org.orgId,
        actorId,
        {
          tillAccountId: tillId,
          amount: "120.0000",
          date: "2026-07-12",
          bankAccountId: org.accounts.bank,
          slipNumber: "ROOT-DROP",
          subsidiaryId: org.subsidiaryId,
        },
        { key: randomUUID(), allowedSubsidiaryIds: scope.allowedSubsidiaryIds },
      );
      assert.equal(rootDrop.window.difference, "0.0000");
      assert.equal(
        (await readSaleTillWindow(org.orgId, rootSale, scope.allowedSubsidiaryIds))?.window
          .subsidiaryId,
        org.subsidiaryId,
      );
      assert.equal(
        (
          await readTillDropWindow(org.orgId, tillId, "2026-07-11", {
            subsidiaryId: branchId,
            allowedSubsidiaryIds: new Set([branchId]),
          })
        ).dropped,
        "900.0000",
        "root drop does not alter the other entity's retained count",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a till drop records by till and date before its sales are posted, and windows reconcile",
  { skip: !DB },
  async () => {
    const { org, actorId, tillId } = await setup();
    try {
      const firstSale = await draftSale(org, tillId, "2026-07-10", "120.0000");
      const secondSale = await draftSale(org, tillId, "2026-07-11", "80.0000");
      assert.equal(
        await readSaleTillWindow(org.orgId, secondSale),
        null,
        "no drop has closed the window yet",
      );
      const before = await readTillDropWindow(org.orgId, tillId, "2026-07-12", {
        allowedSubsidiaryIds: null,
      });
      assert.deepEqual(
        {
          after: before.after,
          sales: before.salesCount,
          tendered: before.tendered,
          dropped: before.dropped,
        },
        { after: null, sales: 2, tendered: "200.0000", dropped: "0.0000" },
      );

      const first = await recordTillDrop(
        org.orgId,
        actorId,
        {
          tillAccountId: tillId,
          amount: "200.0000",
          date: "2026-07-12",
          bankAccountId: org.accounts.bank,
          slipNumber: "SLIP-T1",
        },
        { key: randomUUID() },
      );
      assert.equal(
        first.posted,
        true,
        `the drop posts though neither sale is posted: ${first.postRefusal ?? ""}`,
      );
      assert.equal(
        first.window.difference,
        "0.0000",
        "the window's sales explain the drop exactly",
      );
      const lines = await withBypassContext(() =>
        db.execute<{ account_id: string; amount: string }>(
          sql`
      select l.account_id, l.amount::text from journal_lines l
       where l.org_id = ${org.orgId} and l.entry_id = ${first.entryId}`,
          "objects",
        ),
      );
      assert.ok(
        lines.some(
          (line) =>
            line.account_id === org.accounts.bank && toUnits(line.amount) === toUnits("200"),
        ),
        "bank debited",
      );
      assert.ok(
        lines.some(
          (line) => line.account_id === tillId && toUnits(line.amount) === toUnits("-200"),
        ),
        "till credited",
      );

      const closing = await readSaleTillWindow(org.orgId, secondSale);
      assert.equal(closing?.lastSale, true, "the window's last sale carries its over/short");
      assert.equal(closing?.window.through, "2026-07-12");
      assert.equal(
        (await readSaleTillWindow(org.orgId, firstSale))?.lastSale,
        false,
        "an earlier sale in the window does not",
      );

      // The next window starts after the first drop: a later sale and drop
      // reconcile on their own, and an over-count needs its reason.
      await draftSale(org, tillId, "2026-07-13", "50.0000");
      await assert.rejects(
        recordTillDrop(
          org.orgId,
          actorId,
          {
            tillAccountId: tillId,
            amount: "70.0000",
            date: "2026-07-14",
            bankAccountId: org.accounts.bank,
            slipNumber: "SLIP-T2",
          },
          { key: randomUUID() },
        ),
        (error: unknown) =>
          error instanceof CashDepositError &&
          error.status === 422 &&
          /50\.0000/.test(error.message),
      );
      const second = await recordTillDrop(
        org.orgId,
        actorId,
        {
          tillAccountId: tillId,
          amount: "70.0000",
          date: "2026-07-14",
          bankAccountId: org.accounts.bank,
          slipNumber: "SLIP-T2",
          reason: "Two sales from the afternoon not yet entered",
        },
        { key: randomUUID() },
      );
      assert.deepEqual(
        {
          after: second.window.after,
          sales: second.window.salesCount,
          tendered: second.window.tendered,
          dropped: second.window.dropped,
          difference: second.window.difference,
        },
        {
          after: "2026-07-12",
          sales: 1,
          tendered: "50.0000",
          dropped: "70.0000",
          difference: "20.0000",
        },
      );
      const custom = (
        await withBypassContext(() =>
          db.execute<{ custom: { tillDrop?: { reason?: string } } }>(
            sql`
      select custom from documents where org_id = ${org.orgId} and id = ${second.transferId}`,
            "objects",
          ),
        )
      )[0]!.custom;
      assert.equal(
        custom.tillDrop?.reason,
        "Two sales from the afternoon not yet entered",
        "the count reason rides the drop",
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a replayed till drop keeps the same transfer and reconciled amount",
  { skip: !DB },
  async () => {
    const { org, actorId, tillId } = await setup();
    try {
      await draftSale(org, tillId, "2026-07-12", "100.0000");
      const key = randomUUID();
      const input = {
        tillAccountId: tillId,
        amount: "100.0000",
        date: "2026-07-12",
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-REPLAY",
      };
      const first = await recordTillDrop(org.orgId, actorId, input, { key });
      const replay = await recordTillDrop(org.orgId, actorId, input, { key });
      assert.equal(replay.transferId, first.transferId);
      assert.equal(replay.posted, true);
      assert.equal(replay.window.dropped, "100.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test("till drops use the selected subsidiary functional currency", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  const subsidiaryId = randomUUID();
  let stage = "creating the USD subsidiary";
  try {
    await withBypassContext(async () => {
      await db.execute(
        sql`insert into currencies(code,name,minor_units) values('USD','US Dollar',2) on conflict(code) do nothing`,
      );
      await db.execute(sql`insert into subsidiaries(id,org_id,name,parent_id,base_currency,country,is_active,is_elimination,custom)
        values(${subsidiaryId},${org.orgId},'US Entity',${org.subsidiaryId},'USD','US',true,false,'{}'::jsonb)`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"multiSubsidiary":true,"multiCurrency":true}'::jsonb)
        where id=${org.orgId}`);
    });
    stage = "seeding subsidiary-owned accounts";
    const branchTillId = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "1017", "US Till Cash", "asset_current_other", subsidiaryId),
    );
    const branchBankId = await withBypassContext(() =>
      seedPostingAccount(org.orgId, "1018", "US Deposit Bank", "asset_bank", subsidiaryId),
    );
    stage = "configuring the till and deposit accounts";
    await withBypassContext(() =>
      db.execute(sql`
      update orgs set settings = settings || jsonb_build_object('cashSales',
        coalesce(settings->'cashSales', '{}'::jsonb) ||
        jsonb_build_object('depositAccountIds', jsonb_build_array(${branchBankId}::text),
                           'defaultCashAccountId', ${branchTillId}::text))
       where id = ${org.orgId}`),
    );
    stage = "creating the USD cash sale";
    await draftSale(org, branchTillId, "2026-07-12", "40.0000", subsidiaryId, "USD");
    stage = "recording the USD till drop";
    const drop = await recordTillDrop(
      org.orgId,
      actorId,
      {
        tillAccountId: branchTillId,
        amount: "40.0000",
        date: "2026-07-12",
        bankAccountId: branchBankId,
        slipNumber: "SLIP-USD",
        subsidiaryId,
      },
      { key: randomUUID(), allowedSubsidiaryIds: new Set([subsidiaryId]) },
    );
    assert.equal(drop.posted, true, drop.postRefusal ?? "");
    stage = "reading the posted transfer";
    const document = (
      await withBypassContext(() =>
        db.execute<{ currency: string; subsidiary_id: string }>(
          sql`
      select currency, subsidiary_id from documents where org_id=${org.orgId} and id=${drop.transferId}`,
          "objects",
        ),
      )
    )[0];
    assert.equal(document?.currency, "USD");
    assert.equal(document?.subsidiary_id, subsidiaryId);
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message.replace(/\s+/g, " ")}; cause: ${error.cause instanceof Error ? error.cause.message.replace(/\s+/g, " ") : String(error.cause ?? "")}`
        : String(error);
    assert.fail(`Till-drop currency scenario failed while ${stage}: ${detail}`);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("till drops fence the till and the destination", { skip: !DB }, async () => {
  const { org, actorId, tillId } = await setup();
  try {
    await assert.rejects(
      recordTillDrop(
        org.orgId,
        actorId,
        {
          tillAccountId: org.accounts.revenue,
          amount: "10.0000",
          date: "2026-07-12",
          bankAccountId: org.accounts.bank,
          slipNumber: "SLIP-X",
          reason: "counted float",
        },
        { key: randomUUID() },
      ),
      (error: unknown) =>
        error instanceof CashDepositError && /no till takes cash/.test(error.message),
    );
    await assert.rejects(
      recordTillDrop(
        org.orgId,
        actorId,
        {
          tillAccountId: tillId,
          amount: "10.0000",
          date: "2026-07-12",
          bankAccountId: org.accounts.revenue,
          slipNumber: "SLIP-Y",
          reason: "counted float",
        },
        { key: randomUUID() },
      ),
      (error: unknown) =>
        error instanceof CashDepositError && /configured deposit accounts/.test(error.message),
    );
    // A posted sale's own drop still counts in the till's window.
    const saleId = await draftSale(org, tillId, "2026-07-12", "40.0000");
    await withBypassContext(() =>
      db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount, tax_amount, quantity, unit_price, custom)
      values (${randomUUID()}, ${org.orgId}, ${saleId}, 1, ${org.accounts.revenue}, '40', '40', '0', '1', '40', '{}'::jsonb)`),
    );
    await withBypassContext(() =>
      db.execute(
        sql`update documents set status = 'approved', posting_date = document_date where id = ${saleId} and org_id = ${org.orgId}`,
      ),
    );
    await withOrg(org.orgId, () =>
      postDocument(saleId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      }),
    );
    await recordCashDeposit(
      org.orgId,
      actorId,
      {
        saleId,
        amount: "40.0000",
        date: "2026-07-12",
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-S",
      },
      { key: randomUUID() },
    );
    const window = await readTillDropWindow(org.orgId, tillId, "2026-07-12", {
      allowedSubsidiaryIds: null,
    });
    assert.equal(window.dropped, "40.0000", "sale-linked drops leave the same till window");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test(
  "a drop's cash cutoff ends its window, and a late drop behind a later one needs a note",
  { skip: !DB },
  async () => {
    const { org, actorId, tillId } = await setup();
    try {
      await draftSale(org, tillId, "2026-07-10", "120.0000");
      await draftSale(org, tillId, "2026-07-11", "80.0000");
      // Sold on the drop day itself, after the counted cash left the till.
      await draftSale(org, tillId, "2026-07-12", "45.0000");
      const covering = await recordTillDrop(
        org.orgId,
        actorId,
        {
          tillAccountId: tillId,
          amount: "200.0000",
          date: "2026-07-12",
          coversThrough: "2026-07-11",
          bankAccountId: org.accounts.bank,
          slipNumber: "SLIP-C1",
        },
        { key: randomUUID() },
      );
      assert.deepEqual(
        {
          through: covering.window.through,
          sales: covering.window.salesCount,
          tendered: covering.window.tendered,
          difference: covering.window.difference,
        },
        { through: "2026-07-11", sales: 2, tendered: "200.0000", difference: "0.0000" },
        "the drop day's own sale stays out of the window its cash cutoff closes",
      );
      const next = await readTillDropWindow(org.orgId, tillId, "2026-07-13", {
        allowedSubsidiaryIds: null,
      });
      assert.deepEqual(
        {
          after: next.after,
          sales: next.salesCount,
          tendered: next.tendered,
          dropped: next.dropped,
        },
        { after: "2026-07-11", sales: 1, tendered: "45.0000", dropped: "0.0000" },
        "the next window starts after the cutoff and carries the drop day's sale",
      );

      await assert.rejects(
        recordTillDrop(
          org.orgId,
          actorId,
          {
            tillAccountId: tillId,
            amount: "120.0000",
            date: "2026-07-10",
            bankAccountId: org.accounts.bank,
            slipNumber: "SLIP-LATE",
          },
          { key: randomUUID() },
        ),
        (error: unknown) =>
          error instanceof CashDepositError &&
          /later drop from this till already covers sales through 2026-07-11/.test(error.message),
      );
      const late = await recordTillDrop(
        org.orgId,
        actorId,
        {
          tillAccountId: tillId,
          amount: "120.0000",
          date: "2026-07-10",
          bankAccountId: org.accounts.bank,
          slipNumber: "SLIP-LATE",
          reason: "Slip found after the later drop was entered",
        },
        { key: randomUUID() },
      );
      assert.equal(late.posted, true, late.postRefusal ?? "");

      await assert.rejects(
        recordTillDrop(
          org.orgId,
          actorId,
          {
            tillAccountId: tillId,
            amount: "10.0000",
            date: "2026-07-12",
            coversThrough: "2026-07-13",
            bankAccountId: org.accounts.bank,
            slipNumber: "SLIP-FUTURE",
          },
          { key: randomUUID() },
        ),
        (error: unknown) =>
          error instanceof CashDepositError && /on or before the drop date/.test(error.message),
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
