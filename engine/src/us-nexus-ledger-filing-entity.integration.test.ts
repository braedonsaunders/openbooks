import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";
import { computeUsNexusStatus } from "./us-nexus-ledger.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Filing-entity nexus ledger (item 6E): nexus obligations attach to legal
// entities, so the ledger measures per filing entity in that entity's working
// currency with the USD reference thresholds translated at a declared policy
// rate — never an org-wide USD blend across entities.

/** Posted-document shell the nexus query reads (documents + addresses only). */
async function seedPostedSale(
  org: ScratchOrg,
  opts: { subsidiaryId: string; number: string; currency: string; fxRate: string; subtotal: string },
): Promise<void> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, origin)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${opts.subsidiaryId}, ${`SHELL-${opts.number}`},
            ${org.date}, ${org.periodId}, 'nexus shell', 'manual')`);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total,
       posted_entry_id, posting_period_id)
    values (${randomUUID()}, ${org.orgId}, 'customer_invoice', 'posted', ${opts.number},
            ${opts.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
            ${opts.currency}, ${opts.fxRate}, ${opts.subtotal}, '0.0000', ${opts.subtotal},
            ${entryId}, ${org.periodId})`);
}

async function seedTwoEntityNexusOrg(): Promise<{ org: ScratchOrg; usSub: string }> {
  const org = await createScratchOrg();
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('USD', 'US Dollar', 2)
    on conflict (code) do nothing`);
  const usSub = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Ops', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into addresses (id, org_id, party_id, is_default_shipping, country, region)
    values (${randomUUID()}, ${org.orgId}, ${org.customerId}, true, 'US', 'CA')`);
  // CAD 200 sale on the root entity; USD 1000 sale on the USD entity.
  await seedPostedSale(org, {
    subsidiaryId: org.subsidiaryId, number: "NEX-CAD", currency: "CAD",
    fxRate: "1.0000000000", subtotal: "200.0000",
  });
  await seedPostedSale(org, {
    subsidiaryId: usSub, number: "NEX-USD", currency: "USD",
    fxRate: "1.0000000000", subtotal: "1000.0000",
  });
  return { org, usSub };
}

async function seedUsdToCad(orgId: string): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, 'USD', 'CAD', '2026-07-01', 'spot', '1.3500000000', 'manual')`);
}

test("an entity ledger measures in the entity's functional currency", { skip: !DB }, async () => {
  const { org, usSub } = await seedTwoEntityNexusOrg();
  try {
    // USD entity defaults to its USD functional: thresholds apply directly.
    const usd = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31", null, {
      subsidiaryIds: [usSub],
    });
    assert.equal(usd.currency, "USD");
    assert.deepEqual(usd.subsidiaryIds, [usSub]);
    assert.equal(usd.translation, null);
    assert.equal(usd.states[0]?.state, "CA");
    assert.equal(usd.states[0]?.salesUsd, "1000.0000");
    assert.equal(usd.states[0]?.threshold.salesUsd, 500000);

    // CAD entity measures only its own sale, in CAD.
    await seedUsdToCad(org.orgId);
    const cad = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31", null, {
      subsidiaryIds: [org.subsidiaryId],
    });
    assert.equal(cad.currency, "CAD");
    assert.equal(cad.states[0]?.salesUsd, "200.0000");
    // The CA $500k sales-only trigger translates at the policy rate.
    assert.equal(cad.states[0]?.threshold.salesUsd, 675000);
    assert.equal(cad.states[0]?.status, "none");
    assert.ok(cad.translation);
    assert.equal(cad.translation.rateType, "spot");
    assert.equal(cad.translation.rateDate, "2026-07-31");
    assert.equal(cad.translation.rateAsOf, "2026-07-01");
    assert.equal(cad.translation.usdToCurrencyRate, "1.3500000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a mixed-currency entity fails closed without a declared currency", { skip: !DB }, async () => {
  const { org, usSub } = await seedTwoEntityNexusOrg();
  try {
    await assert.rejects(
      computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31", null, {
        subsidiaryIds: [org.subsidiaryId, usSub],
      }),
      /spans functional currencies \(CAD and USD\)/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a declared working currency converts every entity sale through one rate", { skip: !DB }, async () => {
  const { org, usSub } = await seedTwoEntityNexusOrg();
  try {
    await seedUsdToCad(org.orgId);
    const result = await computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31", null, {
      subsidiaryIds: [org.subsidiaryId, usSub],
      currency: "CAD",
    });
    assert.equal(result.currency, "CAD");
    // CAD 200 raw + USD 1000 at the spot fallback (unstamped 1.0 header) × 1.35.
    assert.equal(result.states[0]?.salesUsd, "1550.0000");
    assert.equal(result.states[0]?.threshold.salesUsd, 675000);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("entity scope ANDs with visibility scope", { skip: !DB }, async () => {
  const { org, usSub } = await seedTwoEntityNexusOrg();
  try {
    // The caller sees only the root but asks for the USD entity: empty ledger.
    const result = await computeUsNexusStatus(
      org.orgId,
      "2026-07-01",
      "2026-07-31",
      new Set([org.subsidiaryId]),
      { subsidiaryIds: [usSub] },
    );
    assert.equal(result.states.length, 0);
    assert.equal(result.unattributed.salesUsd, "0");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("threshold translation fails closed without rate coverage", { skip: !DB }, async () => {
  const { org } = await seedTwoEntityNexusOrg();
  try {
    await assert.rejects(
      computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31", null, {
        subsidiaryIds: [org.subsidiaryId],
      }),
      /cannot translate nexus thresholds USD→CAD/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the org-wide ledger still evaluates in USD with no evidence object", { skip: !DB }, async () => {
  const { org } = await seedTwoEntityNexusOrg();
  try {
    // No entity scope, no currency: the historical org-wide USD ledger. The
    // CAD 200 sale has no rate coverage here and must fail exactly as before —
    // coverage gaps never silently resolve to 1.0.
    await assert.rejects(
      computeUsNexusStatus(org.orgId, "2026-07-01", "2026-07-31"),
      /no spot rate for CAD→USD|no \w+ rate for CAD→USD/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
