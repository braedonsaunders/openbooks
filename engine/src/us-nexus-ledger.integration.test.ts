import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";
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
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total,
       posted_entry_id, posting_period_id)
    values (${randomUUID()}, ${org.orgId}, 'customer_invoice', 'posted', ${number},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
            ${tender.currency}, ${tender.fxRate}, '100000.0000', '0.0000', '100000.0000',
            ${entryId}, ${org.periodId})`);
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
