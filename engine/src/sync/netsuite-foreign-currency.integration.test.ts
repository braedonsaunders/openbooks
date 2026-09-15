/**
 * NetSuite foreign-currency regression coverage (fleet r02).
 *
 * The NetSuite adapter used to drop the transaction currency/rate, so a
 * foreign-currency source document posted at face value as base currency and
 * every foreign account missed trial balance. These cases pin the corrected
 * end state: the built document states its transaction currency and rate, the
 * kernel books base-currency GL, and the open balance stays in transaction
 * currency (the unit the source's open-item truth speaks).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { postDocument } from "../posting.ts";
import { createScratchOrg, type ScratchOrg } from "../test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Lease a fresh scratch org per top-level test. The suite's fixture lifecycle
 * hook drains forgotten leases at every top-level test boundary, so an org
 * memoized across tests is reset — and re-leased to another worker process —
 * as soon as the first test ends.
 */
async function ctx(): Promise<ScratchOrg> {
  return createScratchOrg();
}

test(
  "a foreign-currency invoice books base-currency GL with a transaction-currency open balance",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    // The shape the fixed NetSuite builder now emits for a 100 USD invoice at
    // 1.20: document currency USD, explicit rate, USD line amounts.
    const id = randomUUID();
    const actor = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, party_id,
                               document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${o.orgId}, 'customer_invoice', 'draft', ${`FX-${id.slice(0, 8)}`},
                ${o.customerId}, ${o.date}, 'USD', '1.2000000000', '100.0000', '0.0000', '100.0000', ${actor})`);
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, created_by)
        values (${o.orgId}, ${id}, 1, ${o.accounts.revenue}, 'foreign invoice',
                '1', '100.00000000', '100.0000', ${actor})`);
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

    const legs = await db.execute<{
      amount: string;
      currency: string;
      txnAmount: string;
      fxRate: string;
      openItem: boolean;
    }>(sql`
      select jl.amount::text as "amount", jl.currency as "currency",
             jl.txn_amount::text as "txnAmount", jl.fx_rate::text as "fxRate",
             jl.is_open_item as "openItem"
        from journal_lines jl
        join documents d on d.posted_entry_id = jl.entry_id and d.org_id = jl.org_id
       where d.id = ${id} and d.org_id = ${o.orgId} and jl.is_open_item`);
    assert.equal(legs.rows.length, 1);
    // Functional GL is the converted value, not the foreign face value: a
    // builder that drops currency/rate would book 100.0000 here.
    assert.equal(legs.rows[0]!.amount, "120.0000");
    assert.equal(legs.rows[0]!.currency, "USD");
    assert.equal(legs.rows[0]!.txnAmount, "100.0000");

    const doc = await db.execute<{ openBalance: string | null }>(sql`
      select open_balance::text as "openBalance" from documents
       where id = ${id} and org_id = ${o.orgId}`);
    assert.equal(doc.rows[0]!.openBalance, "100.0000");
  },
);
