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
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting.ts";
import { createScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { reconcileApplications } from "./applications.ts";
import { toSourceApplicationLinks } from "./netsuite-source.ts";

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

test(
  "a fully-paid foreign invoice settles to zero through converted link amounts",
  { skip: !DB, timeout: 120_000 },
  async () => {
    // A 100 EUR invoice paid in full from a 100 EUR payment at carrying rates
    // 1.2/1.1. The source link states 100 in transaction currency; the
    // adapter must convert it to the payer's 120.0000 functional before the
    // reconciler sees it. Feeding the foreign face value through settles only
    // ~83.33 and leaves a repair-proof 16.6667 open on both documents while
    // reporting unallocated zero and alreadySettled on re-run.
    const o = await ctx();
    const payDoc = randomUUID();
    const invDoc = randomUUID();
    const payEntry = randomUUID();
    const invEntry = randomUUID();
    const payLine = randomUUID();
    const payBank = randomUUID();
    const invLine = randomUUID();
    const invBank = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id,
                             document_date, posting_date, currency, status, subtotal, tax_total,
                             total, custom)
      values (${payDoc}, ${o.orgId}, 'customer_payment', 'PAY-FXNS', ${o.customerId},
              ${o.subsidiaryId}, ${o.date}, ${o.date}, 'EUR', 'approved', 100, 0, 100,
              '{"nsId":"pay-fxns"}'::jsonb),
             (${invDoc}, ${o.orgId}, 'customer_invoice', 'INV-FXNS', ${o.customerId},
              ${o.subsidiaryId}, ${o.date}, ${o.date}, 'EUR', 'approved', 100, 0, 100,
              '{"nsId":"inv-fxns"}'::jsonb)`);
    await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
                                   period_id, memo, status, source_document_id, origin)
      values (${payEntry}, ${o.orgId}, ${o.bookId}, ${o.subsidiaryId}, 'PAY-FXNS',
              ${o.date}, ${o.periodId}, 'fx settlement fixture', 'draft', ${payDoc}, 'document'),
             (${invEntry}, ${o.orgId}, ${o.bookId}, ${o.subsidiaryId}, 'INV-FXNS',
              ${o.date}, ${o.periodId}, 'fx settlement fixture', 'draft', ${invDoc}, 'document')`);
    await db.execute(sql`
      insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id,
                                 amount, currency, txn_amount, fx_rate, party_id, is_open_item)
      values (${payLine}, ${o.orgId}, ${payEntry}, 1, ${o.accounts.ar}, ${o.subsidiaryId},
              120, 'EUR', 100, 1.2, ${o.customerId}, true),
             (${payBank}, ${o.orgId}, ${payEntry}, 2, ${o.accounts.bank}, ${o.subsidiaryId},
              -120, 'CAD', -120, 1, null, false),
             (${invLine}, ${o.orgId}, ${invEntry}, 1, ${o.accounts.ar}, ${o.subsidiaryId},
              -110, 'EUR', -100, 1.1, ${o.customerId}, true),
             (${invBank}, ${o.orgId}, ${invEntry}, 2, ${o.accounts.bank}, ${o.subsidiaryId},
              110, 'CAD', 110, 1, null, false)`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now()
       where id in (${payEntry}, ${invEntry})`);
    await db.execute(sql`
      update documents set posted_entry_id = ${payEntry}, posting_period_id = ${o.periodId},
        status = 'posted' where id = ${payDoc} and org_id = ${o.orgId}`);
    await db.execute(sql`
      update documents set posted_entry_id = ${invEntry}, posting_period_id = ${o.periodId},
        status = 'posted' where id = ${invDoc} and org_id = ${o.orgId}`);

    // Stated terms now: the reconciler converts centrally at the booked line
    // rate (1.2 here, matching the payer rate), so the proof expectations —
    // both balances 0.0000, clean re-run — are unchanged.
    const links = toSourceApplicationLinks(
      [
      {
        previousdoc: "inv-fxns",
        previousline: "0",
        nextdoc: "pay-fxns",
        nextline: "0",
        foreignamount: "100",
        paycurrency: "EUR",
        payexrate: "1.2",
      },
      ],
      "CAD",
    );
    assert.deepEqual(links, [
      {
        paymentRef: "pay-fxns",
        appliedRef: "inv-fxns",
        amount: "100",
        currency: "EUR",
        rate: "1.2",
      },
    ]);

    const first = await reconcileApplications(o.orgId, "nsId", links);
    assert.equal(first.unallocated, "0.0000");
    assert.equal(first.skippedNoLine, 0);

    const balances = await db.execute<{ n: string; ob: string | null }>(sql`
      select document_number as "n", open_balance::text as "ob" from documents
       where org_id = ${o.orgId} and id in (${payDoc}, ${invDoc}) order by 1`);
    assert.deepEqual(balances.rows, [
      { n: "INV-FXNS", ob: "0.0000" },
      { n: "PAY-FXNS", ob: "0.0000" },
    ]);

    const second = await reconcileApplications(o.orgId, "nsId", links);
    assert.equal(second.inserted, 0);
    assert.equal(second.alreadySettled, 1);
  },
);
