import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { laborFxQuote, laborFxRate } from "./labor-costing.ts";

/**
 * laborFxRate/laborFxQuote regression (integration partition): the one
 * canonical as-of spot resolver both payroll costing and comp-cycle
 * budget evidence freeze through. Direct quotes win ties, the inverse
 * leg arrives pre-oriented, newer coverage wins, missing coverage is
 * null (callers refuse by name), and same-currency stays '1' with no
 * quote. Dedicated file; payroll costing owns no FX test today.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function withOrg(fn: (org: ScratchOrg) => Promise<void>): Promise<void> {
  if (!DB) return;
  const org = await createScratchOrg();
  try {
    await fn(org);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function seedFx(orgId: string, from: string, to: string, asOf: string, rate: string, source = "manual"): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, ${from}, ${to}, ${asOf}::date, 'spot', ${rate}, ${source})
  `);
}

test("laborFxRate resolves direct, prefers newer, and refuses nothing itself", { skip: !DB }, async () => {
  await withOrg(async (org) => {
    await seedFx(org.orgId, "USD", "CAD", "2025-01-01", "1.35", "bank");
    await seedFx(org.orgId, "USD", "CAD", "2024-06-01", "1.25");
    // Newest on-or-before wins; future coverage never leaks back.
    assert.equal(await laborFxRate(org.orgId, "USD", "CAD", "2025-04-01"), "1.3500000000");
    assert.equal(await laborFxRate(org.orgId, "USD", "CAD", "2024-12-31"), "1.2500000000");
    assert.equal(await laborFxRate(org.orgId, "USD", "CAD", "2024-05-31"), null);
    // Same currency converts 1:1 with no quote row.
    assert.equal(await laborFxRate(org.orgId, "CAD", "CAD", "2025-04-01"), "1");
    // Missing coverage is null — the caller names the remedy.
    assert.equal(await laborFxRate(org.orgId, "EUR", "CAD", "2025-04-01"), null);
  });
});

test("laborFxRate inverts once, exactly, and direct wins ties", { skip: !DB }, async () => {
  await withOrg(async (org) => {
    await seedFx(org.orgId, "USD", "CAD", "2025-01-01", "1.35", "bank");
    // 1/1.35 oriented CAD→USD at numeric(19,10): pre-inverted once.
    const inverse = await laborFxRate(org.orgId, "CAD", "USD", "2025-04-01");
    assert.equal(inverse, "0.7407407407");
    // A same-date direct quote beats the inverse leg.
    await seedFx(org.orgId, "CAD", "USD", "2025-01-01", "0.75", "manual");
    assert.equal(await laborFxRate(org.orgId, "CAD", "USD", "2025-04-01"), "0.7500000000");
  });
});

test("laborFxQuote carries the winning evidence, oriented", { skip: !DB }, async () => {
  await withOrg(async (org) => {
    await seedFx(org.orgId, "USD", "CAD", "2025-01-01", "1.35", "bank");
    const direct = await laborFxQuote(org.orgId, "USD", "CAD", "2025-04-01");
    assert.deepEqual(direct, { rate: "1.3500000000", asOf: "2025-01-01", source: "bank", inverse: false });
    const inverse = await laborFxQuote(org.orgId, "CAD", "USD", "2025-04-01");
    assert.deepEqual(inverse, { rate: "0.7407407407", asOf: "2025-01-01", source: "bank", inverse: true });
    // Same currency needs no quote; missing coverage is null.
    assert.equal(await laborFxQuote(org.orgId, "CAD", "CAD", "2025-04-01"), null);
    assert.equal(await laborFxQuote(org.orgId, "EUR", "CAD", "2025-04-01"), null);
  });
});
