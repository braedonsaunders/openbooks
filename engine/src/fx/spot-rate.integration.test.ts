import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { averageSpotRate, lookupSpotRate } from "./spot-rate.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedQuote(orgId: string, from: string, to: string, asOf: string, rate: string): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, ${from}, ${to}, ${asOf}, 'spot', ${rate}, 'manual')
  `);
}

test("lookup prefers the direct quote when both directions share the newest date", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Provider syncs write every directed pair for one as_of, and double
    // rounding can separate the candidates by a unit: the DIRECT row must
    // win so identical postings never convert alike amounts at two rates.
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-15", "1.0820000000");
    await seedQuote(org.orgId, "CAD", "USD", "2026-07-15", "0.9242144177");
    assert.equal(await lookupSpotRate(db, org.orgId, "USD", "CAD", "2026-07-31"), "1.0820000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lookup inverts the stored quote when only the inverse pair exists", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedQuote(org.orgId, "CAD", "USD", "2026-07-15", "0.8000000000");
    assert.equal(await lookupSpotRate(db, org.orgId, "USD", "CAD", "2026-07-31"), "1.2500000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lookup takes the latest quote on or before the date", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-10", "1.1000000000");
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-20", "1.2000000000");
    await seedQuote(org.orgId, "USD", "CAD", "2026-08-01", "9.9999999999");
    assert.equal(await lookupSpotRate(db, org.orgId, "USD", "CAD", "2026-07-31"), "1.2000000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lookup returns null when the pair is uncovered instead of defaulting", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await lookupSpotRate(db, org.orgId, "USD", "CAD", "2026-07-31"), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lookup translates a currency to itself at par without coverage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await lookupSpotRate(db, org.orgId, "USD", "USD", "2026-07-31"), "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("average mixes direct and inverse quotes across the window", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-10", "1.0000000000");
    await seedQuote(org.orgId, "CAD", "USD", "2026-07-20", "0.5000000000");
    // (1.0 + 2.0) / 2 — the inverse quote contributes inverted.
    assert.equal(await averageSpotRate(db, org.orgId, "USD", "CAD", "2026-07-01", "2026-07-31"), "1.5000000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("average returns null when the window holds no quote in either direction", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await averageSpotRate(db, org.orgId, "USD", "CAD", "2026-07-01", "2026-07-31"), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
