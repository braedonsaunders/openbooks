import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import {
  importSettlementBatch,
  parseChargebeeSettlement,
  parseRecurlySettlement,
  parseStripeBalanceTransactions,
  PspSettlementError,
  type ParsedSettlement,
} from "./psp-settlement.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function stripeRows() {
  return [
    {
      id: "ch_date_1",
      type: "charge",
      amount: 10000,
      currency: "CAD",
    },
  ];
}

async function assertNothingPersisted(orgId: string, externalRef: string): Promise<void> {
  const batches = (await db.execute<{ id: string }>(sql`
    select id from psp_settlement_batches
     where org_id = ${orgId} and provider = 'stripe' and external_ref = ${externalRef}
  `)).rows;
  assert.deepEqual(batches, [], "refused import must leave no settlement batch");
  const lines = (await db.execute<{ id: string }>(sql`
    select l.id from psp_settlement_lines l
      join psp_settlement_batches b on b.id = l.batch_id
     where b.org_id = ${orgId} and b.external_ref = ${externalRef}
  `)).rows;
  assert.deepEqual(lines, [], "refused import must leave no settlement lines");
  const audit = (await db.execute<{ id: string }>(sql`
    select id from audit_log
     where org_id = ${orgId} and changes::text like ${`%${externalRef}%`}
  `)).rows;
  assert.deepEqual(audit, [], "refused import must leave no audit evidence");
}

async function assertRefused(orgId: string, parsed: ParsedSettlement): Promise<void> {
  await assert.rejects(importSettlementBatch(orgId, null, parsed, {}), (error) => {
    assert.ok(error instanceof PspSettlementError, `expected PspSettlementError, got: ${(error as Error)?.message}`);
    assert.match(error.message, /settlement date must be a real calendar date \(YYYY-MM-DD\)/);
    assert.doesNotMatch(error.message, /invalid input syntax|Failed query/i);
    return true;
  });
  await assertNothingPersisted(orgId, parsed.externalRef);
}

// PAY-04: the import path forwarded settlementDate unvalidated, so an
// impossible date died in Postgres as a raw driver error (HTTP 500 at the
// route, which maps only PspSettlementError to 422) instead of a named
// refusal. The reverse action guards the identical shape with
// isIsoCalendarDate ("reversalDate must be a real calendar date").
// importSettlementBatch is the single pre-write choke point, so the guard
// there covers every provider parser and every direct caller.
test("settlement import refuses junk settlementDate with a named error", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const externalRef = `payout-junk-${org.orgId}`;
    const parsed = parseStripeBalanceTransactions(stripeRows(), externalRef, "not-a-date");
    await assertRefused(org.orgId, parsed);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("settlement import refuses month 13 and February 30", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    for (const bad of ["2024-13-01", "2023-02-30"]) {
      const externalRef = `payout-bad-${bad}-${org.orgId}`;
      const parsed = parseStripeBalanceTransactions(stripeRows(), externalRef, bad);
      await assertRefused(org.orgId, parsed);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("settlement import refuses impossible provider timestamps", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Providers ship timestamps; the parsers keep normalizing the leading
    // calendar day, and the import boundary refuses the impossible result.
    const recurly = parseRecurlySettlement(
      { id: `rc-bad-${org.orgId}`, currency: "CAD", closed_at: "2023-02-30T10:00:00.000Z", charge_amount: "10" },
      org.date,
    );
    assert.equal(recurly.settlementDate, "2023-02-30");
    const stripeRef = `payout-recurly-bad-${org.orgId}`;
    await assertRefused(org.orgId, { ...recurly, provider: "stripe", externalRef: stripeRef });
    const chargebee = parseChargebeeSettlement(
      { id: `cb-bad-${org.orgId}`, currency_code: "CAD", total: 1000, amount_paid: 1000, date: "2023-02-30" },
      org.date,
    );
    assert.equal(chargebee.settlementDate, "2023-02-30");
    await assertRefused(org.orgId, { ...chargebee, provider: "stripe", externalRef: `payout-cb-bad-${org.orgId}` });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("settlement import refuses a hand-built batch with a junk date", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Direct callers bypass the provider parsers entirely; the import
    // boundary still refuses before the first write.
    const parsed: ParsedSettlement = {
      provider: "stripe",
      externalRef: `payout-handbuilt-${org.orgId}`,
      settlementDate: "junk",
      currency: "CAD",
      lines: [{ kind: "charge", amount: "100.0000", currency: "CAD", externalRef: "charge-1" }],
    };
    await assertRefused(org.orgId, parsed);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("settlement import keeps valid leap days, timestamps, and the missing-date fallback", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A real leap day imports.
    const leap = parseStripeBalanceTransactions(stripeRows(), `payout-leap-${org.orgId}`, "2024-02-29");
    const leapResult = await importSettlementBatch(org.orgId, null, leap, {});
    assert.equal(leapResult.created, true);
    // A valid provider timestamp normalizes to its calendar day and imports.
    const stamped = parseRecurlySettlement(
      { id: `rc-stamped-${org.orgId}`, currency: "CAD", closed_at: "2024-02-29T15:00:00.000Z", charge_amount: "10" },
      org.date,
    );
    assert.equal(stamped.settlementDate, "2024-02-29");
    assert.ok(isIsoCalendarDate(stamped.settlementDate));
    const stampedResult = await importSettlementBatch(org.orgId, null, stamped, {});
    assert.equal(stampedResult.created, true);
    // A missing date keeps its existing contract: default to the current day.
    const fallback = parseRecurlySettlement({ id: `rc-fallback-${org.orgId}`, currency: "CAD", charge_amount: "10" });
    assert.ok(isIsoCalendarDate(fallback.settlementDate), `fallback date must stay valid, got ${fallback.settlementDate}`);
    const fallbackResult = await importSettlementBatch(org.orgId, null, fallback, {});
    assert.equal(fallbackResult.created, true);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
