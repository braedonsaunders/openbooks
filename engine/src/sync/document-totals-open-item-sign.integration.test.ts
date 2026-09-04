/**
 * A posted document's denormalized header total is stated in the DOCUMENT's
 * direction, not the ledger's.
 *
 * setDocumentTotalsFromEntry derives the header from the posted entry's
 * open-item (control) leg. That leg's sign is a property of the control
 * account, not of the document: a customer invoice's AR leg is a DEBIT (+), a
 * vendor bill's AP leg is a CREDIT (-). Reading the leg verbatim therefore
 * stated every open payable negatively, so the header/lines storage invariant
 * rejected the write -- a NetSuite full migration failed roughly a third of its
 * documents this way, with the guard (correctly) refusing each one.
 *
 * These cases pin both directions of the correction and, just as importantly,
 * that the receivable side is untouched: for an AR control leg the multiplier
 * is 1, making the expression algebraically identical to the original.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { postDocument } from "../posting.ts";
import { createScratchOrg, type ScratchOrg } from "../test-fixtures.ts";
import { setDocumentTotalsFromEntry } from "./sync.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

let org: ScratchOrg | null = null;
async function ctx(): Promise<ScratchOrg> {
  if (!org) org = await createScratchOrg();
  return org;
}

/** A one-line document, posted through the real kernel so the entry it
 *  denormalizes from is a genuine posted entry with a real open-item leg. */
async function postOneLineDocument(
  o: ScratchOrg,
  kind: "vendor_bill" | "customer_invoice" | "customer_credit",
  amount: string,
): Promise<string> {
  const id = randomUUID();
  const actor = randomUUID();
  const partyId = kind === "vendor_bill" ? o.vendorId : o.customerId;
  const lineAccount =
    kind === "vendor_bill" ? o.accounts.cogs : o.accounts.revenue;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, party_id,
                             document_date, currency, subtotal, tax_total, total, created_by)
      values (${id}, ${o.orgId}, ${kind}, 'draft', ${`${kind}-${id.slice(0, 8)}`},
              ${partyId}, ${o.date}, 'CAD', ${amount}, '0', ${amount}, ${actor})`);
    await tx.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description,
                                  quantity, unit_price, amount, created_by)
      values (${o.orgId}, ${id}, 1, ${lineAccount}, 'sign regression',
              '1', ${amount}, ${amount}, ${actor})`);
  });
  await db.execute(sql`
    update documents set status = 'approved' where id = ${id} and org_id = ${o.orgId}`);
  await postDocument(id, {
    control: {
      ar: o.accounts.ar,
      ap: o.accounts.ap,
      bank: o.accounts.bank,
    },
  });
  return id;
}

async function header(orgId: string, docId: string) {
  const res = await db.execute<{ subtotal: string; tax_total: string; total: string }>(sql`
    select subtotal, tax_total, total from documents
     where id = ${docId} and org_id = ${orgId}`);
  return res.rows[0]!;
}

async function openItemLeg(orgId: string, docId: string): Promise<number> {
  const res = await db.execute<{ amount: string }>(sql`
    select jl.amount from journal_lines jl
      join documents d on d.posted_entry_id = jl.entry_id and d.org_id = jl.org_id
     where d.id = ${docId} and d.org_id = ${orgId} and jl.is_open_item
     limit 1`);
  return Number(res.rows[0]!.amount);
}

test(
  "a payable's header total is positive even though its control leg is a credit",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    const billId = await postOneLineDocument(o, "vendor_bill", "39.9200");

    // The premise: the AP control leg really is negative. Without this the
    // test could pass for the wrong reason on a chart that posts AP as a debit.
    assert.ok(
      (await openItemLeg(o.orgId, billId)) < 0,
      "a vendor bill's AP open-item leg must be a credit for this case to mean anything",
    );

    await setDocumentTotalsFromEntry(billId, o.orgId);
    const h = await header(o.orgId, billId);
    assert.equal(
      Number(h.total),
      39.92,
      "the bill is +39.92 in its own direction; reading the credit leg verbatim yields -39.92 and trips the header/lines invariant",
    );
    assert.equal(Number(h.subtotal), 39.92);
  },
);

test(
  "a receivable's header total is unchanged, because its multiplier is 1",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    const invoiceId = await postOneLineDocument(o, "customer_invoice", "39.9200");

    assert.ok(
      (await openItemLeg(o.orgId, invoiceId)) > 0,
      "a customer invoice's AR open-item leg is a debit",
    );

    await setDocumentTotalsFromEntry(invoiceId, o.orgId);
    const h = await header(o.orgId, invoiceId);
    assert.equal(
      Number(h.total),
      39.92,
      "the receivable side must be untouched by the payable-side correction",
    );
  },
);

test(
  "a credit whose lines are stored positive gets a header that ties to them",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    // The importer stores a credit's lines POSITIVE, but its AR control leg is
    // a credit, so deriving the sign from that leg produced a negative header
    // against positive lines -- a header that could never tie, which is what
    // the remaining production failures were: exact magnitude, wrong sign.
    const creditId = await postOneLineDocument(o, "customer_credit", "2503.8400");

    const leg = await openItemLeg(o.orgId, creditId);
    assert.ok(leg < 0, "a customer credit's AR open-item leg is a credit");

    await setDocumentTotalsFromEntry(creditId, o.orgId);
    const h = await header(o.orgId, creditId);
    const lines = await db.execute<{ sum: string }>(sql`
      select coalesce(sum(amount), 0) as sum from document_lines
       where document_id = ${creditId} and org_id = ${o.orgId}`);
    assert.equal(
      Number(h.total),
      Number(lines.rows[0]!.sum),
      "the derived header must tie to the document's own lines, in sign as well as magnitude",
    );
  },
);
