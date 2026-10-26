import { installEngineSeams } from "../composition/install.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { decideGate } from "../flows/gates.ts";
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
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";

installEngineSeams();

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const control = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function configureDeposits(orgId: string, bankIds: string[]): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
    update orgs set settings = jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"cashSales":true}'::jsonb) || jsonb_build_object('cashSales',
      coalesce(settings->'cashSales', '{}'::jsonb) ||
      jsonb_build_object('depositAccountIds',
        (select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements_text(${JSON.stringify(bankIds)}::jsonb) as value)))
     where id = ${orgId}`),
  );
}

interface DropFixture {
  org: ScratchOrg;
  actorId: string;
  saleId: string;
  saleNumber: string;
  tillId: string;
  secondTillId: string | null;
}

async function fixture(cashTendered: string, secondTillTendered?: string): Promise<DropFixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Till Cashier", "cashier"),
  );
  const tillId = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "1015", "Till Cash", "asset_current_other", org.subsidiaryId),
  );
  const secondTillId = secondTillTendered
    ? await withBypassContext(() =>
        seedPostingAccount(
          org.orgId,
          "1016",
          "Second Till Cash",
          "asset_current_other",
          org.subsidiaryId,
        ),
      )
    : null;
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
  const firstTillMinor =
    toUnits(cashTendered) - (secondTillTendered ? toUnits(secondTillTendered) : 0n);
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into document_tenders
        (org_id, document_id, position, kind, method_label, account_id,
         stored_value_account_id, amount_minor, currency, reference)
      values (${org.orgId}, ${saleId}, 1, 'cash', 'cash', ${tillId}, null,
              ${firstTillMinor.toString()}, 'CAD', null)`);
    if (secondTillId && secondTillTendered) {
      await db.execute(sql`
        insert into document_tenders
          (org_id, document_id, position, kind, method_label, account_id,
           stored_value_account_id, amount_minor, currency, reference)
        values (${org.orgId}, ${saleId}, 2, 'cash', 'cash', ${secondTillId}, null,
                ${toUnits(secondTillTendered).toString()}, 'CAD', null)`);
    }
  });
  await withBypassContext(() =>
    db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, quantity, unit_price, custom)
      values (${randomUUID()}, ${org.orgId}, ${saleId}, 1, ${org.accounts.revenue},
              ${cashTendered}, ${cashTendered}, '0', '1', ${cashTendered}, '{}'::jsonb)`),
  );
  await withBypassContext(() =>
    db.execute(
      sql`update documents set status = 'approved' where id = ${saleId} and org_id = ${org.orgId}`,
    ),
  );
  await withOrg(org.orgId, () => postDocument(saleId, control(org)));
  return { org, actorId, saleId, saleNumber, tillId, secondTillId };
}

test("a till drop posts a transfer from till cash to the bank", { skip: !DB }, async () => {
  const { org, actorId, saleId, saleNumber, tillId } = await fixture("100.0000");
  try {
    assert.equal(
      await withOrg(org.orgId, () =>
        actorHasPermission(db, org.orgId, actorId, "cash_sales.deposit"),
      ),
      true,
    );
    assert.equal(
      await withOrg(org.orgId, () => actorHasPermission(db, org.orgId, actorId, "gl.post")),
      false,
    );
    const drop = await recordCashDeposit(
      org.orgId,
      actorId,
      {
        saleId,
        amount: "60.0000",
        date: org.date,
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-1",
      },
      { key: randomUUID() },
    );
    assert.equal(drop.posted, true);
    assert.ok(drop.entryId);
    const legs = await db.execute<{ number: string | null; amount: string }>(
      sql`
      select a.number, l.amount::text as amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where e.org_id = ${org.orgId} and e.source_document_id = ${drop.transferId}
       order by l.line_number`,
      "objects",
    );
    assert.deepEqual(
      legs.map((leg) => [leg.number, leg.amount]),
      [
        ["1000", "60.0000"],
        ["1015", "-60.0000"],
      ],
    );
    const link = (
      await db.execute<{ link: unknown }>(
        sql`
      select custom->'cashSaleDeposit' as link from documents
       where org_id = ${org.orgId} and id = ${drop.transferId}`,
        "objects",
      )
    )[0]?.link;
    assert.deepEqual(link, { saleId, slipNumber: "SLIP-1" });
    // The lifetime cap counts the posted drop: 40.00 remains.
    await assert.rejects(
      recordCashDeposit(
        org.orgId,
        actorId,
        {
          saleId,
          amount: "50.0000",
          date: org.date,
          bankAccountId: org.accounts.bank,
          slipNumber: "SLIP-2",
        },
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
      {
        saleId,
        amount: "100.0000",
        date: org.date,
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-9",
      },
      { key },
    );
    const second = await recordCashDeposit(
      org.orgId,
      actorId,
      {
        saleId,
        amount: "100.0000",
        date: org.date,
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-9",
      },
      { key },
    );
    assert.equal(first.transferId, second.transferId);
    assert.equal(second.posted, true);
    const count = (
      await db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from documents
       where org_id = ${org.orgId} and kind = 'transfer' and status <> 'voided'`,
        "objects",
      )
    )[0]?.n;
    assert.equal(count, "1");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("cash sale drops are capped and counted per tender account", { skip: !DB }, async () => {
  const { org, actorId, saleId, tillId, secondTillId } = await fixture("100.0000", "40.0000");
  assert.ok(secondTillId);
  try {
    await recordCashDeposit(
      org.orgId,
      actorId,
      {
        saleId,
        amount: "35.0000",
        date: org.date,
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-B",
        sourceAccountId: secondTillId,
      },
      { key: randomUUID() },
    );
    await assert.rejects(
      recordCashDeposit(
        org.orgId,
        actorId,
        {
          saleId,
          amount: "10.0000",
          date: org.date,
          bankAccountId: org.accounts.bank,
          slipNumber: "SLIP-B2",
          sourceAccountId: secondTillId,
        },
        { key: randomUUID() },
      ),
      (error: unknown) =>
        error instanceof CashDepositError && /undropped till cash 5\.0000/.test(error.message),
    );
    const firstTillDrop = await recordCashDeposit(
      org.orgId,
      actorId,
      {
        saleId,
        amount: "60.0000",
        date: org.date,
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-A",
        sourceAccountId: tillId,
      },
      { key: randomUUID() },
    );
    assert.equal(firstTillDrop.posted, true);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("drops refuse without configured deposit accounts", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Till Cashier", "cashier"),
    );
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
      db.execute(
        sql`update documents set status = 'approved' where id = ${saleId} and org_id = ${org.orgId}`,
      ),
    );
    await withOrg(org.orgId, () => postDocument(saleId, control(org)));
    await assert.rejects(
      recordCashDeposit(
        org.orgId,
        actorId,
        {
          saleId,
          amount: "10.0000",
          date: org.date,
          bankAccountId: org.accounts.bank,
          slipNumber: "SLIP-X",
        },
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

test(
  "drops refuse an unposted sale, a missing slip and an outside bank",
  { skip: !DB },
  async () => {
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
          {
            saleId: draftId,
            amount: "10.0000",
            date: org.date,
            bankAccountId: org.accounts.bank,
            slipNumber: "S",
          },
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
          {
            saleId,
            amount: "10.0000",
            date: org.date,
            bankAccountId: org.accounts.bank,
            slipNumber: "  ",
          },
          {},
        ),
        (error: unknown) =>
          error instanceof CashDepositError &&
          error.status === 422 &&
          /slip number/.test(error.message),
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
  },
);

test(
  "till deposits enforce the operator's native permission and the Cash Sales feature before writing",
  { skip: !DB },
  async () => {
    const { org, actorId, saleId } = await fixture("100.0000");
    try {
      const outsider = await createScratchUser(
        org.orgId,
        "Unassigned operator",
        "unassigned_cash_operator",
      );
      const input = {
        saleId,
        amount: "60.0000",
        date: org.date,
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-AUTHORITY",
      };
      await assert.rejects(
        recordCashDeposit(org.orgId, outsider, input, { key: randomUUID() }),
        ScopeNotFoundError,
      );
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features,cashSales}','false'::jsonb) where id=${org.orgId}`,
      );
      await assert.rejects(
        recordCashDeposit(org.orgId, actorId, input, { key: randomUUID() }),
        (error: unknown) => error instanceof CashDepositError && error.status === 404,
      );
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from documents
      where org_id=${org.orgId} and kind='transfer'`,
            "objects",
          )
        )[0]!.count,
        0,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a till deposit waits for every tenant-configured Flow and posts once after release",
  { skip: !DB },
  async () => {
    const { org, actorId, saleId } = await fixture("100.0000");
    try {
      const approvers = await Promise.all(
        ["First bookkeeper", "Second bookkeeper"].map((name) =>
          createScratchUser(org.orgId, name, "accountant"),
        ),
      );
      for (const userId of approvers)
        await seedApprovalFlow(org.orgId, {
          subjectKind: "transfer",
          mode: "all",
          assignees: [{ type: "user", userId }],
        });
      const input = {
        saleId,
        amount: "60.0000",
        date: org.date,
        bankAccountId: org.accounts.bank,
        slipNumber: "SLIP-FLOWS",
      };
      const key = randomUUID();
      const pending = await recordCashDeposit(org.orgId, actorId, input, { key });
      assert.equal(pending.posted, false);
      const gates = await db.execute<{ id: string; assignee_user_id: string }>(
        sql`select id,assignee_user_id from flow_gates
      where org_id=${org.orgId} and subject_kind='transfer' and subject_id=${pending.transferId} and status='pending' order by id`,
        "objects",
      );
      assert.equal(gates.length, 2);
      await decideGate({
        gateId: gates[0]!.id,
        userId: gates[0]!.assignee_user_id,
        decision: "approved",
      });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents
      where org_id=${org.orgId} and id=${pending.transferId}`,
            "objects",
          )
        )[0]!.status,
        "pending_approval",
      );
      await decideGate({
        gateId: gates[1]!.id,
        userId: gates[1]!.assignee_user_id,
        decision: "approved",
      });
      const posted = await recordCashDeposit(org.orgId, actorId, input, { key });
      assert.equal(posted.posted, true);
      assert.equal(posted.transferId, pending.transferId);
      assert.equal(
        (await recordCashDeposit(org.orgId, actorId, input, { key })).transferId,
        pending.transferId,
      );
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from journal_entries
      where org_id=${org.orgId} and source_document_id=${pending.transferId} and status='posted'`,
            "objects",
          )
        )[0]!.count,
        1,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
