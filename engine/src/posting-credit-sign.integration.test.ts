import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "./db.ts";
import { PostingError, postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Draft a one-or-more-line credit memo with exact matching totals, approved and ready to post. */
async function draftCredit(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  userId: string,
  documentNumber: string,
  amounts: string[],
  kind: "customer_credit" | "vendor_credit" = "customer_credit",
): Promise<string> {
  const id = randomUUID();
  const subtotal = amounts.reduce((n, a) => n + Number(a), 0).toFixed(4);
  const partyId = kind === "vendor_credit" ? org.vendorId : org.customerId;
  const lineAccount = kind === "vendor_credit" ? org.accounts.cogs : org.accounts.revenue;
  const created = await withBypass(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${id}, ${org.orgId}, ${kind}, 'draft', ${documentNumber},
              ${org.subsidiaryId}, ${partyId}, ${org.date}, 'CAD', '1',
              ${subtotal}, '0', ${subtotal}, ${userId})`);
    let lineNumber = 0;
    for (const amount of amounts) {
      lineNumber += 1;
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
        values (${org.orgId}, ${id}, ${lineNumber}, ${lineAccount},
                '1', ${amount}, ${amount}, '0')`);
    }
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${id} and org_id = ${org.orgId}`);
    return id;
  });
  return created;
}

test("a negative-total credit memo cannot post as a shadow invoice", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Credit sign guard", "admin"));
    // A credit memo stated against its own direction: posting this would
    // debit AR and credit income — a receivable the collections ladder would
    // never chase, typed as a credit. Debit memos are invoices.
    const id = await draftCredit(org, userId, "CM-NEG-TOTAL", ["-50"]);
    await assert.rejects(
      postDocument(id, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      }),
      (error: unknown) =>
        error instanceof PostingError &&
        /a credit memo must carry a positive total; a negative balance owed by the customer is an invoice/.test(
          error.message,
        ),
    );
    const untouched = await db.execute<{ status: string; entries: number }>(sql`
      select status,
             (select count(*)::int from journal_entries where source_document_id = ${id}) as entries
        from documents where id = ${id} and org_id = ${org.orgId}
    `);
    assert.deepEqual(untouched.rows[0], { status: "approved", entries: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a negative-total vendor credit cannot post as a shadow bill", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Credit sign guard", "admin"));
    // The AP mirror of the shadow invoice: a vendor "credit" stated against
    // its own direction would debit expense and credit AP — a payable typed
    // as a credit. Amounts owed to a vendor are bills, not credits.
    const id = await draftCredit(org, userId, "VC-NEG-TOTAL", ["-50"], "vendor_credit");
    await assert.rejects(
      postDocument(id, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      }),
      (error: unknown) =>
        error instanceof PostingError &&
        /a credit memo must carry a positive total; a negative balance owed to the vendor is a bill/.test(
          error.message,
        ),
    );
    const untouched = await db.execute<{ status: string; entries: number }>(sql`
      select status,
             (select count(*)::int from journal_entries where source_document_id = ${id}) as entries
        from documents where id = ${id} and org_id = ${org.orgId}
    `);
    assert.deepEqual(untouched.rows[0], { status: "approved", entries: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a mixed-sign credit memo with a positive total still posts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Credit sign guard", "admin"));
    // A restocking fee netted inside a genuine credit stays postable: only
    // the inverted document direction is refused.
    const id = await draftCredit(org, userId, "CM-MIXED-POS", ["100", "-20"]);
    const entryId = await postDocument(id, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    const legs = (await db.execute<{ accountId: string; amount: string }>(sql`
      select account_id as "accountId", amount::text as amount from journal_lines
       where entry_id = ${entryId} order by line_number
    `));
    assert.deepEqual(
      legs.rows.map((l) => [
        l.accountId === org.accounts.ar ? "ar" : "income",
        l.amount,
      ]),
      [["ar", "-80.0000"], ["income", "100.0000"], ["income", "-20.0000"]],
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
