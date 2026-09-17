import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "./db.ts";
import { PostingError, postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * F-t06-002: a USD deposit into a CAD-restricted bank account. The storage
 * trigger (`jl_check_account`) is the only defense, and its UUID-laden
 * exception used to escape as a 500 with the raw INSERT pasted into the UI.
 * The kernel must refuse first with a typed PostingError naming the account
 * and its allowed currency — which the route answers as a 422 — and leave
 * no partial journal behind.
 */
test("a deposit into a currency-mismatched account refuses with a typed posting error", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const userId = await withBypass(() => createScratchUser(org.orgId, "Treasurer", "admin"));
    const id = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId},'USD','CAD',${org.date}::date,'spot',1.35,'manual')`);
      await db.execute(sql`update accounts set currency_restriction = 'CAD' where id = ${org.accounts.bank} and org_id = ${org.orgId}`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${org.orgId}, 'deposit', 'draft', 'DEP-CCY-MISMATCH',
                ${org.subsidiaryId}, ${org.date}, 'USD', '1.35',
                '12450.0000', '0', '12450.0000', ${userId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
        values (${org.orgId}, ${id}, 1, ${org.accounts.revenue},
                '1', '12450.0000', '12450.0000', '0')`);
      await db.execute(sql`
        update documents set status = 'approved', updated_at = now()
         where id = ${id} and org_id = ${org.orgId}`);
    });
    await assert.rejects(
      postDocument(id, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      }),
      (error: unknown) =>
        error instanceof PostingError &&
        /1000/.test(error.message) &&
        /Cash/.test(error.message) &&
        /CAD/.test(error.message) &&
        !/Failed query/i.test(error.message) &&
        !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(error.message),
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
