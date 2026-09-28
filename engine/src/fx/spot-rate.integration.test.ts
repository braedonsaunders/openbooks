import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  averageSpotRate,
  averageSpotRateForMonthWithEvidence,
  lookupSpotRate,
  lookupSpotRateWithEvidence,
} from "./spot-rate.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedQuote(orgId: string, from: string, to: string, asOf: string, rate: string): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, ${from}, ${to}, ${asOf}, 'spot', ${rate}, 'manual')
  `);
}

async function seedProviderQuote(orgId: string, from: string, to: string, asOf: string, rate: string): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, ${from}, ${to}, ${asOf}, 'spot', ${rate}, 'ecb')
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

test("the database refuses non-positive FX observations", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await assert.rejects(
      seedQuote(org.orgId, "USD", "CAD", "2026-07-15", "0"),
      (error: unknown) => {
        let current: unknown = error;
        for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
          const candidate = current as { cause?: unknown; constraint?: string };
          if (candidate.constraint === "fx_rates_positive_rate") return true;
          current = candidate.cause;
        }
        return false;
      },
    );
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

test("average counts one quote per date when both directions quote the same day", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-10", "1.0000000000");
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-20", "2.0000000000");
    await seedQuote(org.orgId, "CAD", "USD", "2026-07-20", "0.5000000000");
    // Jul 20 exists in both directions: the direct 2.0 wins and the inverted
    // 0.5 must not double-count it — (1.0 + 2.0) / 2, not (1+2+2)/3.
    assert.equal(await averageSpotRate(db, org.orgId, "USD", "CAD", "2026-07-01", "2026-07-31"), "1.5000000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("average keeps the direct quote when a date is quoted both ways", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Same pair as the lookup tie test: double rounding separates the direct
    // quote from the inverted one, so averaging both would not reproduce the
    // direct rate.
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-15", "1.0820000000");
    await seedQuote(org.orgId, "CAD", "USD", "2026-07-15", "0.9242144177");
    assert.equal(await averageSpotRate(db, org.orgId, "USD", "CAD", "2026-07-01", "2026-07-31"), "1.0820000000");
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

test("as-of evidence names the direct observation with exact decimals", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-15", "1.0820000000");
    const evidence = await lookupSpotRateWithEvidence(db, org.orgId, "USD", "CAD", "2026-07-31");
    assert.equal(evidence.kind, "as-of");
    assert.equal(evidence.rate, "1.0820000000");
    assert.equal(evidence.sameCurrencyPar, false);
    assert.equal(evidence.policy, "direct-or-inverse-spot");
    assert.equal(evidence.table, "fx_rates");
    assert.equal(evidence.observations.length, 1);
    const [observation] = evidence.observations;
    assert.match(observation!.id, /^[0-9a-f-]{36}$/);
    assert.equal(observation!.asOf, "2026-07-15");
    assert.equal(observation!.source, "manual");
    assert.equal(observation!.storedRate, "1.0820000000");
    assert.match(observation!.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(observation!.direction, "direct");
    assert.equal(observation!.derivedRate, "1.0820000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("as-of evidence inverts with exact decimals and keeps the stored quote", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedQuote(org.orgId, "CAD", "USD", "2026-07-15", "0.8000000000");
    const evidence = await lookupSpotRateWithEvidence(db, org.orgId, "USD", "CAD", "2026-07-31");
    assert.equal(evidence.rate, "1.2500000000");
    assert.equal(evidence.observations.length, 1);
    const [observation] = evidence.observations;
    assert.equal(observation!.asOf, "2026-07-15");
    assert.equal(observation!.direction, "inverse");
    assert.equal(observation!.storedRate, "0.8000000000");
    assert.equal(observation!.derivedRate, "1.2500000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("evidence returns exact par with explicit provenance for same-currency pairs", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const asOf = await lookupSpotRateWithEvidence(db, org.orgId, "USD", "USD", "2026-07-31");
    assert.equal(asOf.rate, "1");
    assert.equal(asOf.sameCurrencyPar, true);
    assert.deepEqual(asOf.observations, []);
    assert.equal(asOf.policy, "direct-or-inverse-spot");
    assert.equal(asOf.table, "fx_rates");
    assert.match(asOf.digest, /^[0-9a-f]{64}$/);
    const month = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "USD", 2026, 7);
    assert.equal(month.rate, "1");
    assert.equal(month.sameCurrencyPar, true);
    assert.deepEqual(month.observations, []);
    assert.equal(month.monthStart, "2026-07-01");
    assert.equal(month.monthEnd, "2026-07-31");
    assert.match(month.digest, /^[0-9a-f]{64}$/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("month evidence keeps exact calendar boundaries regardless of accounting periods", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A non-calendar accounting period ending Jul 25 must not narrow the
    // window: the helper takes only (year, month), so Jul 1 and Jul 31 both
    // contribute while Jun 30 and Aug 1 stay outside.
    await seedQuote(org.orgId, "USD", "CAD", "2026-06-30", "9.0000000000");
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-01", "1.0000000000");
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-31", "2.0000000000");
    await seedQuote(org.orgId, "USD", "CAD", "2026-08-01", "9.0000000000");
    const evidence = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "CAD", 2026, 7);
    assert.equal(evidence.kind, "calendar-month-average");
    assert.equal(evidence.monthStart, "2026-07-01");
    assert.equal(evidence.monthEnd, "2026-07-31");
    assert.deepEqual(evidence.observations.map((o) => o.asOf), ["2026-07-01", "2026-07-31"]);
    assert.equal(evidence.rate, "1.5000000000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("month evidence returns null with no closing fallback when the month is quoteless", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A quote just outside the month must not rescue it: there is no
    // closing/current fallback, so the later metrics caller can refuse.
    await seedQuote(org.orgId, "USD", "CAD", "2026-08-05", "1.7500000000");
    const evidence = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "CAD", 2026, 7);
    assert.equal(evidence.rate, null);
    assert.deepEqual(evidence.observations, []);
    assert.match(evidence.digest, /^[0-9a-f]{64}$/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a manual dated spot row wins with evidence over the provider quote", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Two provider dates: the manual correction must win by selection among
    // rows, not merely by being the only row left standing.
    await seedProviderQuote(org.orgId, "USD", "CAD", "2026-07-10", "1.1000000000");
    await seedProviderQuote(org.orgId, "USD", "CAD", "2026-07-20", "1.2000000000");
    // The operator corrects the Jul 20 row in place (the unique index on
    // org/pair/date admits one row per direction). The correction must match
    // exactly one row — a zero-row write is a lost correction, not a save.
    const corrected = await db.execute<{ id: string }>(sql`
      update fx_rates set source = 'manual', rate = 1.2345678901
       where org_id = ${org.orgId} and from_currency = 'USD' and to_currency = 'CAD'
         and as_of = '2026-07-20' and rate_type = 'spot'
      returning id
    `);
    assert.equal(corrected.rows.length, 1);
    const evidence = await lookupSpotRateWithEvidence(db, org.orgId, "USD", "CAD", "2026-07-31");
    assert.equal(evidence.rate, "1.2345678901");
    assert.equal(evidence.observations.length, 1);
    assert.equal(evidence.observations[0]!.asOf, "2026-07-20");
    assert.equal(evidence.observations[0]!.source, "manual");
    assert.equal(evidence.observations[0]!.storedRate, "1.2345678901");
    assert.equal(evidence.observations[0]!.direction, "direct");
    // The month window carries the same manual authority on its Jul 20 leg.
    const month = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "CAD", 2026, 7);
    assert.deepEqual(month.observations.map((o) => o.source), ["ecb", "manual"]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a manual consolidated override has no effect on rate evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-15", "1.0820000000");
    const before = await lookupSpotRateWithEvidence(db, org.orgId, "USD", "CAD", "2026-07-31");
    const monthBefore = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "CAD", 2026, 7);
    // The override targets the scratch org's real July accounting period, so a
    // valid consolidated row exists and still must not move rate evidence.
    await db.execute(sql`
      insert into consolidated_fx_rates
        (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
      values (${org.orgId}, ${org.periodId}, 'USD', 'CAD', 99.9999999999, 99.9999999999, 99.9999999999, 'manual')
    `);
    const after = await lookupSpotRateWithEvidence(db, org.orgId, "USD", "CAD", "2026-07-31");
    assert.equal(after.rate, before.rate);
    assert.deepEqual(after.observations, before.observations);
    const monthAfter = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "CAD", 2026, 7);
    assert.equal(monthAfter.rate, monthBefore.rate);
    assert.deepEqual(monthAfter.observations, monthBefore.observations);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("month evidence carries the canonical ordered set and a reproducible digest", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Seeded out of order on purpose: the canonical set is always as_of
    // ascending, so the digest is stable across re-reads.
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-20", "2.0000000000");
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-10", "1.0000000000");
    await seedQuote(org.orgId, "CAD", "USD", "2026-07-15", "0.5000000000");
    const first = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "CAD", 2026, 7);
    // (1.0 + 2.0 + 2.0) / 3 = exact 5/3, normalized to numeric(19,10).
    assert.equal(first.rate, "1.6666666667");
    assert.deepEqual(first.observations.map((o) => o.asOf), ["2026-07-10", "2026-07-15", "2026-07-20"]);
    assert.deepEqual(first.observations.map((o) => o.direction), ["direct", "inverse", "direct"]);
    assert.deepEqual(first.observations.map((o) => o.derivedRate), ["1.0000000000", "2.0000000000", "2.0000000000"]);
    const expected = createHash("sha256").update(JSON.stringify({
      v: 1,
      kind: "calendar-month-average",
      from: "USD",
      to: "CAD",
      scope: { year: 2026, month: 7, monthStart: "2026-07-01", monthEnd: "2026-07-31" },
      policy: "direct-or-inverse-spot",
      table: "fx_rates",
      rate: "1.6666666667",
      observations: first.observations.map((o) => ({
        id: o.id,
        asOf: o.asOf,
        source: o.source,
        storedRate: o.storedRate,
        updatedAt: o.updatedAt,
        direction: o.direction,
        derivedRate: o.derivedRate,
      })),
    })).digest("hex");
    assert.equal(first.digest, expected);
    const second = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "CAD", 2026, 7);
    assert.equal(second.digest, first.digest);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("scalar wrappers stay compatible with the evidence helpers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedQuote(org.orgId, "USD", "CAD", "2026-07-10", "1.0000000000");
    await seedQuote(org.orgId, "CAD", "USD", "2026-07-20", "0.5000000000");
    const lookupEvidence = await lookupSpotRateWithEvidence(db, org.orgId, "USD", "CAD", "2026-07-31");
    assert.equal(await lookupSpotRate(db, org.orgId, "USD", "CAD", "2026-07-31"), lookupEvidence.rate);
    const monthEvidence = await averageSpotRateForMonthWithEvidence(db, org.orgId, "USD", "CAD", 2026, 7);
    assert.equal(
      await averageSpotRate(db, org.orgId, "USD", "CAD", "2026-07-01", "2026-07-31"),
      monthEvidence.rate,
    );
    const emptyEvidence = await lookupSpotRateWithEvidence(db, org.orgId, "USD", "CHF", "2026-07-31");
    assert.equal(await lookupSpotRate(db, org.orgId, "USD", "CHF", "2026-07-31"), emptyEvidence.rate);
    assert.equal(emptyEvidence.rate, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
