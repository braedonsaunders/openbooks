import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument, PostingError } from "./posting.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

/**
 * Exactly-once posting. A document must produce EXACTLY ONE journal entry even
 * under concurrent posts — a duplicate GL entry is the worst (silent) financial
 * defect. The draft→posted flip is a conditional UPDATE inside the write
 * transaction; the racing post matches 0 rows and rolls back, discarding its
 * entry.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("concurrent posts of one document produce exactly one journal entry", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
  try {
    const docId = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                             currency, fx_rate, status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
      values (${docId}, ${org.orgId}, 'vendor_bill', 'BILL-RACE', ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
              'CAD', 1, 'approved', '100', '0', '100', false, '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount,
                                 tax_amount, is_billable, quantity_fulfilled, quantity_billed, stock_location_id, custom,
                                 tax_overridden, extra_dims)
      values (${randomUUID()}, ${org.orgId}, ${docId}, 1, null, ${org.accounts.cogs}, '1', '100', '100', '0',
              false, '0', '0', null, '{}'::jsonb, false, '{}'::jsonb)`);

    // Fire two posts at once.
    const results = await Promise.allSettled([postDocument(docId, deps), postDocument(docId, deps)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, "exactly one post succeeded");
    assert.equal(failed.length, 1, "the racing post was rejected");
    assert.ok((failed[0] as PromiseRejectedResult).reason instanceof PostingError);

    // The invariant: one and only one journal entry for the document.
    const entries = (await db.execute(sql`
      select id from journal_entries where source_document_id = ${docId} and reverses_entry_id is null
    `)) as unknown as { rows: { id: string }[] };
    assert.equal(entries.rows.length, 1, "no duplicate GL entry");

    const doc = (await db.execute(sql`
      select status, posted_entry_id as "postedEntryId" from documents where id = ${docId}
    `)) as unknown as { rows: { status: string; postedEntryId: string | null }[] };
    assert.equal(doc.rows[0]!.status, "posted");
    assert.equal(doc.rows[0]!.postedEntryId, entries.rows[0]!.id, "document points at the one entry");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
