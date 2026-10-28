/**
 * 0015 keeps each document's searchable terms and amounts, and each journal
 * entry's line amounts, in tables row-level security lets an index serve.
 * Every write path that changes what a record contributes re-derives it, the
 * verifier stays empty after each one, and a rebuild reproduces the rows.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/platform/database";
import { postDocument } from "@openbooks/engine/documents";
import {
  assertDedicatedFixtureDatabase,
  createScratchOrg,
  createScratchUser,
  type ScratchOrg,
} from "@openbooks/engine/testing/fixtures";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function terms(org: ScratchOrg, documentId: string): Promise<string[]> {
  const rows = await db.execute<{ term: string }>(
    sql`select term from document_search_terms where org_id = ${org.orgId} and document_id = ${documentId} order by term`,
    "objects",
  );
  return rows.map((row) => row.term);
}

async function amounts(org: ScratchOrg, documentId: string): Promise<string[]> {
  const rows = await db.execute<{ amount: string }>(
    sql`select source || ':' || cents as amount from document_search_amounts
         where org_id = ${org.orgId} and document_id = ${documentId} order by source, cents`,
    "objects",
  );
  return rows.map((row) => row.amount);
}

async function assertSound(org: ScratchOrg, step: string) {
  const drift = await db.execute(sql`select * from openbooks_search_index_verify(${org.orgId})`, "objects");
  assert.deepEqual(drift, [], `the search index agrees with its source after ${step}`);
}

test(
  "the search index follows document, line and journal writes, and a rebuild reproduces it",
  { skip: !DB, timeout: 180_000 },
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await withBypassContext(() => createScratchOrg());
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Searcher", "admin"));
    const invoice = randomUUID();
    const draft = randomUUID();

    await withBypassContext(async () => {
      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, reference_number, memo, subsidiary_id, party_id, document_date, due_date,
         currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoice}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-0003668', 'PO-77', 'May yard work',
          ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date}, 'CAD', 1, '7298.0800', 0, '7298.0800', ${actor})`);
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoice}, 1, ${org.accounts.revenue}, 'Forklift rental', 1, '7000.0000', '7000.0000', 0, '7000.0000'),
               (${org.orgId}, ${invoice}, 2, ${org.accounts.revenue}, 'Fuel surcharge', 1, '298.0800', '298.0800', 0, '298.0800')`);

      const indexed = await terms(org, invoice);
      for (const term of ["inv", "0003668", "3668", "inv", "po", "77", "may", "yard", "work", "forklift", "rental", "fuel", "surcharge"])
        assert.ok(indexed.includes(term), `indexes ${term}`);
      assert.ok(!indexed.includes("inv-0003668"), "punctuation splits terms");
      assert.deepEqual(await amounts(org, invoice), ["line:29808", "line:700000", "lines:729808", "total:729808"]);
      await assertSound(org, "inserting a document and its lines");

      await db.execute(sql`update documents set memo = 'June hauling' where org_id = ${org.orgId} and id = ${invoice}`);
      const renamed = await terms(org, invoice);
      assert.ok(renamed.includes("hauling") && !renamed.includes("yard"), "a memo edit replaces its terms");
      assert.ok(renamed.includes("forklift"), "line terms survive a header edit");

      await db.execute(sql`update document_lines set description = 'Crane rental' where org_id = ${org.orgId} and document_id = ${invoice} and line_number = 1`);
      const relined = await terms(org, invoice);
      assert.ok(relined.includes("crane") && !relined.includes("forklift"), "a line edit replaces its terms");
      await assertSound(org, "editing header and line text");

      await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${invoice}`);
      await postDocument(invoice, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
      assert.ok((await amounts(org, invoice)).includes("open:729808"), "a posted invoice is found by its open balance");
      const journal = await db.execute<{ cents: string; subsidiary_id: string }>(
        sql`select a.cents::text as cents, a.subsidiary_id from journal_search_amounts a
             join journal_entries e on e.org_id = a.org_id and e.id = a.entry_id
            where a.org_id = ${org.orgId} and e.source_document_id = ${invoice} order by a.cents`,
        "objects",
      );
      assert.ok(journal.some((row) => row.cents === "729808"), "the posted entry is found by its line amounts");
      assert.ok(journal.every((row) => row.subsidiary_id === org.subsidiaryId), "journal amounts carry each line's subsidiary");
      await assertSound(org, "posting");

      await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${draft}, ${org.orgId}, 'vendor_bill', 'draft', 'B-12', ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, 'CAD', 1, 0, 0, 0, ${actor})`);
      await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${draft}, 1, ${org.accounts.revenue}, 'Gravel', 1, '50.0000', '50.0000', 0, '50.0000')`);
      assert.ok((await terms(org, draft)).includes("gravel"));
      await db.execute(sql`delete from document_lines where org_id = ${org.orgId} and document_id = ${draft}`);
      assert.ok(!(await terms(org, draft)).includes("gravel"), "a deleted line takes its terms");
      assert.deepEqual(await amounts(org, draft), [], "and its amounts");
      await assertSound(org, "deleting lines");
      await db.execute(sql`delete from documents where org_id = ${org.orgId} and id = ${draft}`);
      assert.deepEqual(await terms(org, draft), [], "a deleted document leaves no terms");
      await assertSound(org, "deleting a document");

      const counts = async () =>
        (
          await db.execute<{ n: number }>(
            sql`select ((select count(*) from document_search_terms where org_id = ${org.orgId})
                      + (select count(*) from document_search_amounts where org_id = ${org.orgId})
                      + (select count(*) from journal_search_amounts where org_id = ${org.orgId}))::int as n`,
            "objects",
          )
        )[0]!.n;
      const before = await counts();
      const rebuilt = await db.execute<{ n: string }>(sql`select openbooks_search_index_rebuild(${org.orgId})::text as n`, "objects");
      assert.equal(Number(rebuilt[0]!.n), before, "a rebuild reproduces every row");
      assert.equal(await counts(), before);
      await assertSound(org, "a rebuild");
    });
  },
);
