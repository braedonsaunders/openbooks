import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { postDocument } from "../ledger/posting-document.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { computeUsNexusStatus } from "./us-nexus-ledger.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Seed a posted document the way legacy/imported history looks: a real journal
 * identity behind it (so the posted-period checks hold) but a caller-chosen
 * header fx_rate — including the '1' default the stamping kernel replaces on
 * every document it posts itself.
 */
async function seedPostedLegacyDocument(
  org: ScratchOrg,
  number: string,
  tender: { currency: string; fxRate: string },
): Promise<void> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, origin)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`LEGACY-${number}`},
            ${org.date}, ${org.periodId}, 'legacy import shell', 'manual')`);
  // Stamped US/CA like a backfilled row: these tests prove FX conversion, so
  // their fixture carries a captured destination and attributes under the
  // post-0265 ledger (unstamped rows are unattributed by design — see below).
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total,
       posted_entry_id, posting_period_id, ship_to_country, ship_to_region)
    values (${randomUUID()}, ${org.orgId}, 'customer_invoice', 'posted', ${number},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
            ${tender.currency}, ${tender.fxRate}, '100000.0000', '0.0000', '100000.0000',
            ${entryId}, ${org.periodId}, 'US', 'CA')`);
}

async function seedUsdOrgWithCaCustomer(org: ScratchOrg): Promise<void> {
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('USD', 'US Dollar', 2), ('EUR', 'Euro', 2)
    on conflict (code) do nothing`);
  await db.execute(sql`update orgs set base_currency = 'USD' where id = ${org.orgId}`);
  await db.execute(sql`update subsidiaries set base_currency = 'USD' where id = ${org.subsidiaryId}`);
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, rate_type, rate, as_of)
    values (${org.orgId}, 'EUR', 'USD', 'spot', '1.1000000000', '2026-07-01')`);
  await db.execute(sql`
    insert into addresses (id, org_id, party_id, is_default_shipping, country, region)
    values (${randomUUID()}, ${org.orgId}, ${org.customerId}, true, 'US', 'CA')`);
}

// Live-Postgres regression: for a USD-base org the ledger used a document's
// stored fx_rate whenever its TEXT differed from '1' — but numeric(19,10)
// reads back as '1.0000000000', so an UNSTAMPED (default-rate) foreign-currency
// sale converted at 1.0 instead of falling through to the spot-rate lookup.
// A EUR 100k sale at a 1.10 spot evaluated as $100k toward nexus, not $110k.
test("unstamped foreign-currency sales convert at the spot rate, not 1.0", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedUsdOrgWithCaCustomer(org);
    await seedPostedLegacyDocument(org, "NEXUS-FX-1", {
      currency: "EUR",
      fxRate: "1.0000000000",
    });

    const result = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31");
    assert.equal(result.states[0]?.state, "CA");
    // 100000 EUR x 1.10 spot = 110000 USD toward the threshold.
    assert.equal(result.states[0]?.salesUsd, "110000.0000");
    assert.equal(result.states[0]?.txnCount, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("stamped foreign-currency sales keep converting at the posted header rate", { skip: !DB }, async () => {
  // The spot fallback must not displace the rate the kernel actually posted
  // at: a stamped 1.35 header rate wins over a 1.10 spot row.
  const org = await createScratchOrg();
  try {
    await seedUsdOrgWithCaCustomer(org);
    await seedPostedLegacyDocument(org, "NEXUS-FX-2", {
      currency: "EUR",
      fxRate: "1.3500000000",
    });

    const result = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31");
    assert.equal(result.states[0]?.salesUsd, "135000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/** Post one manual-rate USD invoice through the real posting kernel. */
async function postKernelInvoice(org: ScratchOrg, number: string, amount: string): Promise<string> {
  const documentId = randomUUID();
  // Lines are immutable outside draft status (0034): draft, seed lines, then
  // approve — the same order the draft writer uses.
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
    values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', ${number},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
            'USD', '1', ${amount}, '0.0000', ${amount})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
       tax_amount, quantity, unit_price)
    values (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue},
            ${amount}, ${amount}, '0.0000', '1', ${amount})`);
  await db.execute(sql`
    update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(documentId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  return documentId;
}

function stateOf(result: Awaited<ReturnType<typeof computeUsNexusStatus>>, state: string) {
  return result.states.find((s) => s.state === state);
}

// A customer's default ship-to moving from CA to NY must not move already-
// posted sales: the ledger attributes each sale to the destination frozen at
// posting, never the live address book. Deleting the address afterwards must
// not move them either — the stamp survives the address.
test("changing or deleting the ship-to after posting does not move prior sales", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedUsdOrgWithCaCustomer(org);
    const documentId = await postKernelInvoice(org, "NEXUS-STAMP-1", "100000.0000");

    const stamp = (await db.execute<{ ship_to_country: string | null; ship_to_region: string | null }>(sql`
      select ship_to_country, ship_to_region from documents where id = ${documentId}`)).rows[0]!;
    assert.deepEqual(
      { country: stamp.ship_to_country, region: stamp.ship_to_region },
      { country: "US", region: "CA" },
      "posting freezes the ship-to jurisdiction on the document",
    );

    const before = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31");
    assert.equal(stateOf(before, "CA")?.salesUsd, "100000.0000");

    // The customer moves to New York after the sale posted.
    await db.execute(sql`
      update addresses set country = 'US', region = 'NY'
       where org_id = ${org.orgId} and party_id = ${org.customerId}`);
    const moved = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31");
    assert.equal(stateOf(moved, "CA")?.salesUsd, "100000.0000");
    assert.equal(stateOf(moved, "CA")?.txnCount, 1);
    assert.equal(stateOf(moved, "NY"), undefined, "an address edit must not re-home posted sales");

    // The address is deleted outright: the frozen sale still attributes.
    await db.execute(sql`
      delete from addresses where org_id = ${org.orgId} and party_id = ${org.customerId}`);
    const orphaned = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31");
    assert.equal(stateOf(orphaned, "CA")?.salesUsd, "100000.0000");
    assert.equal(orphaned.unattributed.txnCount, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// A sale posted with no capturable destination is unattributed — and stays
// that way when an address appears later. Re-homing it to the new address
// would repeat the retroactive-attribution defect in the other direction.
test("sales with no captured destination stay unattributed when an address appears later", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedUsdOrgWithCaCustomer(org);
    await db.execute(sql`
      delete from addresses where org_id = ${org.orgId} and party_id = ${org.customerId}`);
    await postKernelInvoice(org, "NEXUS-STAMP-2", "50000.0000");

    const bare = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31");
    assert.equal(bare.states.length, 0);
    assert.equal(bare.unattributed.salesUsd, "50000.0000");
    assert.equal(bare.unattributed.txnCount, 1);

    // A CA ship-to is filed only after the sale posted: the old sale must
    // not be attracted to it.
    await db.execute(sql`
      insert into addresses (id, org_id, party_id, is_default_shipping, country, region)
      values (${randomUUID()}, ${org.orgId}, ${org.customerId}, true, 'US', 'CA')`);
    const after = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31");
    assert.equal(after.states.length, 0, "a later address must not re-home posted sales");
    assert.equal(after.unattributed.salesUsd, "50000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// Rows posted before the stamp existed attribute through the surviving
// provider-quote evidence: the destination the line's tax was computed for.
test("pre-stamp sales attribute through provider-quote evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedUsdOrgWithCaCustomer(org);
    const lineId = randomUUID();
    const entryId = randomUUID();
    const documentId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'LEGACY-NEXUS-EV',
              ${org.date}, ${org.periodId}, 'legacy import shell', 'manual')`);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', 'NEXUS-EV-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
              'USD', '1', '25000.0000', '0.0000', '25000.0000')`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, quantity, unit_price)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue},
              '25000.0000', '25000.0000', '0.0000', '1', '25000.0000')`);
    await db.execute(sql`
      update documents
         set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
       where id = ${documentId} and org_id = ${org.orgId}`);
    const configId = randomUUID();
    await db.execute(sql`
      insert into tax_rate_provider_configs (id, org_id, provider, display_name, is_enabled)
      values (${configId}, ${org.orgId}, 'taxjar', 'Evidence provider', false)`);
    await db.execute(sql`
      insert into tax_rate_quotes
        (id, org_id, provider_config_id, provider, quoted_on, currency, ship_from, ship_to,
         taxable_amount, tax_amount, components, document_line_id, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${configId}, 'taxjar', ${org.date}, 'USD',
              '{"country": "US", "region": "CA"}'::jsonb,
              '{"country": "US", "region": "TX"}'::jsonb,
              '25000.0000', '0.0000', '[]'::jsonb, ${lineId}, null, null)`);

    // The stamp column is NULL (pre-stamp row) and the customer's live
    // address says CA: the quote evidence (TX) must win over the address.
    const result = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31");
    assert.equal(stateOf(result, "TX")?.salesUsd, "25000.0000");
    assert.equal(stateOf(result, "CA"), undefined);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
