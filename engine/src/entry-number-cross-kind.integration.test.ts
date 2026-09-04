/**
 * A source system's per-type numbering must not cost the ledger a document.
 *
 * Journal entry numbers are unique per organization across every document
 * kind. Source systems number per TRANSACTION TYPE, so a vendor bill and an
 * expense report are both legitimately "1000" -- and an importer cannot ask a
 * human to renumber the source. Before this, the second document to post could
 * not obtain an entry number and simply failed; a production migration lost
 * documents to it, and the error told the operator to renumber a document
 * they did not control.
 *
 * The ledger now resolves the clash itself, qualifying the loser with its kind
 * in the same hyphen-suffix style the source-correction path mints. These
 * cases pin that the sync succeeds, that numbers stay unique, and -- the part
 * that matters most -- that the exactly-once posting guard is untouched.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

let org: ScratchOrg | null = null;
async function ctx(): Promise<ScratchOrg> {
  if (!org) org = await createScratchOrg();
  return org;
}

const control = (o: ScratchOrg) => ({
  control: { ar: o.accounts.ar, ap: o.accounts.ap, bank: o.accounts.bank },
});

/** A one-line approved document carrying an explicit source number. */
async function approvedDocument(
  o: ScratchOrg,
  kind: "vendor_bill" | "expense_report",
  documentNumber: string,
): Promise<string> {
  const id = randomUUID();
  const actor = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, party_id,
                             document_date, currency, subtotal, tax_total, total, created_by)
      values (${id}, ${o.orgId}, ${kind}, 'draft', ${documentNumber}, ${o.vendorId},
              ${o.date}, 'CAD', '100.0000', '0', '100.0000', ${actor})`);
    await tx.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description,
                                  quantity, unit_price, amount, created_by)
      values (${o.orgId}, ${id}, 1, ${o.accounts.cogs}, 'cross-kind number',
              '1', '100.0000', '100.0000', ${actor})`);
  });
  await db.execute(sql`
    update documents set status = 'approved' where id = ${id} and org_id = ${o.orgId}`);
  return id;
}

async function entryNumberOf(orgId: string, documentId: string): Promise<string> {
  const res = await db.execute<{ entry_number: string }>(sql`
    select e.entry_number from journal_entries e
      join documents d on d.posted_entry_id = e.id and d.org_id = e.org_id
     where d.id = ${documentId} and d.org_id = ${orgId}`);
  return res.rows[0]!.entry_number;
}

test(
  "two kinds sharing a source number both post, and the second is qualified by kind",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    const number = `X${randomUUID().slice(0, 8)}`;

    const billId = await approvedDocument(o, "vendor_bill", number);
    await postDocument(billId, control(o));
    assert.equal(
      await entryNumberOf(o.orgId, billId),
      number,
      "the first document to post keeps the natural source number",
    );

    // Same number, different kind -- exactly what a per-type source produces.
    const reportId = await approvedDocument(o, "expense_report", number);
    await postDocument(reportId, control(o));

    assert.equal(
      await entryNumberOf(o.orgId, reportId),
      `${number}-EXPENSE_REPORT`,
      "the colliding document must be qualified automatically, not rejected",
    );

    const posted = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents
       where org_id = ${o.orgId} and document_number = ${number} and status = 'posted'`);
    assert.equal(posted.rows[0]!.n, 2, "no document may be lost to a source numbering clash");
  },
);

test(
  "resolving the clash does not weaken the exactly-once posting guard",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    const number = `Y${randomUUID().slice(0, 8)}`;
    const billId = await approvedDocument(o, "vendor_bill", number);
    await postDocument(billId, control(o));

    // The allocator returns a document its OWN number, so a second post must
    // still be refused by the status flip rather than quietly numbered around.
    await assert.rejects(
      () => postDocument(billId, control(o)),
      // Either refusal is correct: the precondition check catches an already
      // posted document first, and the flip guard catches the concurrent case.
      (error: unknown) => /already posted/.test(String(error)),
      "a document must never post twice, however its number was allocated",
    );

    const entries = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${o.orgId} and source_document_id = ${billId}`);
    assert.equal(entries.rows[0]!.n, 1, "a document can never produce two entries");
  },
);
