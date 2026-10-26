import { createWorkOperator } from "../testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withBypass } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { unapplyCreditSettlement } from "./credit-settlement.ts";
import { InvoiceWriteOffConflictError, writeOffInvoice } from "./invoice-write-off.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Live-Postgres: invoice write-off. A posted customer invoice's open balance is
 * cleared by a customer credit memo on the write-off account, settled against
 * the invoice in the same transaction. These cases pin the balance arithmetic,
 * the account precedence, the refusals, the replay contract and the reversal.
 */

async function withWriteOffOrg(
  displayName: string,
  work: (org: Awaited<ReturnType<typeof createScratchOrg>>, userId: string) => Promise<void>,
): Promise<void> {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() =>
      createWorkOperator(org.orgId, displayName, ["ar.read", "ar.create", "ar.post", "ar.pay"]),
    );
    await work(org, userId);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
}

async function postInvoice(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  userId: string,
  documentNumber: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${documentNumber},
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              ${amount}, '0', ${amount}, ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', ${amount}, ${amount}, '0')`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${id} and org_id = ${org.orgId}`);
  });
  await withBypass(() =>
    postDocument(id, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
  return id;
}

async function addAccount(
  orgId: string,
  number: string,
  name: string,
  type: string,
): Promise<string> {
  const id = randomUUID();
  await withBypass(() =>
    db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                          required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
            '[]'::jsonb, '{}'::jsonb, true)`),
  );
  return id;
}

async function setControlAccounts(orgId: string, controls: Record<string, string>): Promise<void> {
  await withBypass(() =>
    db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts}',
                                coalesce(settings->'controlAccounts', '{}'::jsonb) || ${JSON.stringify(controls)}::jsonb)
     where id = ${orgId}`),
  );
}

async function openItemBalance(orgId: string, documentId: string): Promise<string> {
  const row = await withBypass(
    async () =>
      (
        await db.execute<{ open: string }>(
          sql`
      select (abs(jl.amount) - coalesce(sum(a.amount) filter (where a.unapplied_at is null), 0))::text as open
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        left join applications a on a.to_line_id = jl.id and a.org_id = jl.org_id
       where jl.org_id = ${orgId} and je.source_document_id = ${documentId} and jl.is_open_item
       group by jl.id`,
          "objects",
        )
      )[0],
  );
  return row!.open;
}

async function entryCount(orgId: string): Promise<number> {
  const row = await withBypass(
    async () =>
      (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from journal_entries where org_id = ${orgId}`,
          "objects",
        )
      )[0],
  );
  return Number(row!.n);
}

async function creditMemoCount(orgId: string): Promise<number> {
  const row = await withBypass(
    async () =>
      (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from documents where org_id = ${orgId} and kind = 'customer_credit'`,
          "objects",
        )
      )[0],
  );
  return Number(row!.n);
}

async function postedLines(
  orgId: string,
  documentId: string,
): Promise<Array<{ accountId: string; amount: string }>> {
  const rows = await withBypass(
    async () =>
      await db.execute<{ account_id: string; amount: string }>(
        sql`
      select jl.account_id, jl.amount::text as amount
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and je.source_document_id = ${documentId}
       order by jl.id`,
        "objects",
      ),
  );
  return rows.map((row) => ({ accountId: row.account_id, amount: row.amount }));
}

function writeOff(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  userId: string,
  input: { invoiceId: string; amount: string; key: string; reason?: string; date?: string },
) {
  return withOrgContext(org.orgId, () =>
    writeOffInvoice(
      org.orgId,
      userId,
      {
        invoiceId: input.invoiceId,
        amount: input.amount,
        date: input.date ?? org.date,
        reason: input.reason ?? "Customer ceased trading",
        idempotencyKey: input.key,
      },
      null,
    ),
  );
}

test(
  "a full write-off debits bad debt expense, credits receivables and clears the invoice",
  { skip: !DB },
  () =>
    withWriteOffOrg("Write-off full", async (org, userId) => {
      const badDebt = await addAccount(org.orgId, "6990", "Bad Debt Expense", "expense");
      await setControlAccounts(org.orgId, { badDebtExpense: badDebt });
      const invoiceId = await postInvoice(org, userId, "INV-WO-FULL", "210");
      assert.equal(await openItemBalance(org.orgId, invoiceId), "210.0000");

      const result = await writeOff(org, userId, {
        invoiceId,
        amount: "210.00",
        key: randomUUID(),
      });

      assert.equal(result.status, "written_off");
      assert.equal(result.amount, "210.0000");
      assert.equal(result.accountId, badDebt);
      assert.equal(result.applicationIds.length, 1);
      assert.equal(await openItemBalance(org.orgId, invoiceId), "0.0000");

      const lines = await postedLines(org.orgId, result.creditMemoId);
      assert.deepEqual(
        lines.find((line) => line.accountId === badDebt),
        { accountId: badDebt, amount: "210.0000" },
        "the write-off debits the bad debt account",
      );
      assert.ok(
        lines.some((line) => line.accountId === org.accounts.ar && line.amount === "-210.0000"),
        "the write-off credits the receivable control",
      );
    }),
);

test(
  "a partial write-off leaves the remainder open until a later write-off clears it",
  { skip: !DB },
  () =>
    withWriteOffOrg("Write-off partial", async (org, userId) => {
      const badDebt = await addAccount(org.orgId, "6990", "Bad Debt Expense", "expense");
      await setControlAccounts(org.orgId, { badDebtExpense: badDebt });
      const invoiceId = await postInvoice(org, userId, "INV-WO-PART", "500");

      const first = await writeOff(org, userId, { invoiceId, amount: "200", key: randomUUID() });
      assert.equal(first.amount, "200.0000");
      assert.equal(await openItemBalance(org.orgId, invoiceId), "300.0000");

      const second = await writeOff(org, userId, { invoiceId, amount: "300", key: randomUUID() });
      assert.equal(second.status, "written_off");
      assert.equal(await openItemBalance(org.orgId, invoiceId), "0.0000");
    }),
);

test(
  "a write-off with no configured debit account refuses by naming the setting and records nothing",
  { skip: !DB },
  () =>
    withWriteOffOrg("Write-off unmapped", async (org, userId) => {
      const invoiceId = await postInvoice(org, userId, "INV-WO-UNMAPPED", "210");
      const entriesBefore = await entryCount(org.orgId);
      const creditsBefore = await creditMemoCount(org.orgId);

      await assert.rejects(
        () => writeOff(org, userId, { invoiceId, amount: "210", key: randomUUID() }),
        (error: unknown) => {
          assert.ok(error instanceof PaymentError);
          assert.match(error.message, /Bad debt expense/);
          assert.match(error.message, /Control accounts/);
          return true;
        },
      );
      assert.equal(await openItemBalance(org.orgId, invoiceId), "210.0000");
      assert.equal(await creditMemoCount(org.orgId), creditsBefore);
      assert.equal(await entryCount(org.orgId), entriesBefore);
    }),
);

test("a write-off above the open balance refuses and posts nothing", { skip: !DB }, () =>
  withWriteOffOrg("Write-off over", async (org, userId) => {
    const badDebt = await addAccount(org.orgId, "6990", "Bad Debt Expense", "expense");
    await setControlAccounts(org.orgId, { badDebtExpense: badDebt });
    const invoiceId = await postInvoice(org, userId, "INV-WO-OVER", "210");
    const creditsBefore = await creditMemoCount(org.orgId);

    await assert.rejects(
      () => writeOff(org, userId, { invoiceId, amount: "210.01", key: randomUUID() }),
      (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /210\.0000 or less/);
        return true;
      },
    );
    assert.equal(await openItemBalance(org.orgId, invoiceId), "210.0000");
    assert.equal(await creditMemoCount(org.orgId), creditsBefore);
  }),
);

test(
  "a retried write-off replays the first result, and a changed payload under the same key is refused",
  { skip: !DB },
  () =>
    withWriteOffOrg("Write-off replay", async (org, userId) => {
      const badDebt = await addAccount(org.orgId, "6990", "Bad Debt Expense", "expense");
      await setControlAccounts(org.orgId, { badDebtExpense: badDebt });
      const invoiceId = await postInvoice(org, userId, "INV-WO-REPLAY", "210");
      const key = randomUUID();

      const first = await writeOff(org, userId, { invoiceId, amount: "210", key });
      const entriesAfterFirst = await entryCount(org.orgId);
      const creditsAfterFirst = await creditMemoCount(org.orgId);

      const replay = await writeOff(org, userId, { invoiceId, amount: "210", key });
      assert.equal(replay.status, "replayed");
      assert.equal(replay.creditMemoId, first.creditMemoId);
      assert.deepEqual(replay.applicationIds, first.applicationIds);
      assert.equal(
        await entryCount(org.orgId),
        entriesAfterFirst,
        "a replay posts no second entry",
      );
      assert.equal(
        await creditMemoCount(org.orgId),
        creditsAfterFirst,
        "a replay creates no second credit memo",
      );
      assert.equal(await openItemBalance(org.orgId, invoiceId), "0.0000");

      await assert.rejects(
        () => writeOff(org, userId, { invoiceId, amount: "100", key }),
        InvoiceWriteOffConflictError,
      );
    }),
);

test(
  "an allowance for doubtful accounts takes precedence, and voiding the write-off reopens the invoice",
  { skip: !DB },
  () =>
    withWriteOffOrg("Write-off allowance", async (org, userId) => {
      const badDebt = await addAccount(org.orgId, "6990", "Bad Debt Expense", "expense");
      const allowance = await addAccount(
        org.orgId,
        "1290",
        "Allowance for doubtful accounts",
        "asset_current_other",
      );
      await setControlAccounts(org.orgId, {
        badDebtExpense: badDebt,
        allowanceForDoubtfulAccounts: allowance,
      });
      const invoiceId = await postInvoice(org, userId, "INV-WO-ALLOW", "210");

      const result = await writeOff(org, userId, { invoiceId, amount: "210", key: randomUUID() });
      assert.equal(result.accountId, allowance);
      assert.deepEqual(
        (await postedLines(org.orgId, result.creditMemoId)).find(
          (line) => line.accountId === allowance,
        ),
        { accountId: allowance, amount: "210.0000" },
      );

      // A write-off is reversed by voiding its credit memo. The void refuses while
      // the settlement is live, so the application is released first.
      await withBypass(() =>
        unapplyCreditSettlement(org.orgId, userId, result.applicationIds[0]!, null),
      );
      assert.equal(await openItemBalance(org.orgId, invoiceId), "210.0000");
      const voided = await withOrgContext(org.orgId, () =>
        requestDocumentVoid({
          documentId: result.creditMemoId,
          orgId: org.orgId,
          actorId: userId,
          reason: "Write-off recorded in error",
          reversalDate: org.date,
          source: "api",
        }),
      );
      assert.equal(voided.status, "voided");
      assert.equal(await openItemBalance(org.orgId, invoiceId), "210.0000");
    }),
);
