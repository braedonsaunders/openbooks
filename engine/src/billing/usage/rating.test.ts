import assert from "node:assert/strict";
import test from "node:test";
import { parseMoney, parseQuantity, parseRate } from "../../money/brands.ts";
import type { Rate } from "../../money/brands.ts";
import type { PackageRounding, RatingBandKind, UsageAggregation, UsageRecordInput } from "./rating.ts";
import { sum } from "../../money/money.ts";
import { UsageBillingError } from "./errors.ts";
import { aggregateUsage, applyPrepaid, commitShortfall, rateUsage } from "./rating.ts";
import type { RatingBand } from "./rating.ts";

function record(
  id: string,
  quantity: string,
  options?: { occurredOn?: string; distinctKey?: string | null; reversesId?: string | null },
): UsageRecordInput {
  return {
    id,
    occurredOn: options?.occurredOn ?? "2026-09-01",
    quantity: parseQuantity(quantity),
    distinctKey: options?.distinctKey ?? null,
    reversesId: options?.reversesId ?? null,
  };
}

function band(
  seq: number,
  upToQty: string | null,
  unitPrice: string,
  options?: {
    kind?: RatingBandKind;
    flatAmount?: string;
    includedQty?: string;
    packageSize?: string | null;
    packageRounding?: PackageRounding | null;
  },
): RatingBand {
  return {
    kind: options?.kind ?? "graduated",
    seq,
    upToQty: upToQty === null ? null : parseQuantity(upToQty),
    unitPrice: parseRate(unitPrice),
    flatAmount: parseMoney(options?.flatAmount ?? "0.0000"),
    includedQty: parseQuantity(options?.includedQty ?? "0"),
    packageSize: options?.packageSize === undefined || options?.packageSize === null
      ? null
      : parseQuantity(options.packageSize),
    packageRounding: options?.packageRounding ?? null,
  };
}

test("each aggregation applies reversals", () => {
  const reversed = record("rec-reversed", "5", { reversesId: "rec-target" });
  const cases: { aggregation: UsageAggregation; records: UsageRecordInput[]; expected: string }[] = [
    {
      aggregation: "sum",
      records: [record("rec-a", "10"), record("rec-target", "5"), reversed],
      expected: "10",
    },
    {
      aggregation: "count",
      records: [record("rec-a", "10"), record("rec-target", "5"), reversed],
      expected: "1",
    },
    {
      aggregation: "max",
      records: [record("rec-target", "10"), record("rec-other", "7"), reversed],
      expected: "7",
    },
    {
      aggregation: "last",
      records: [
        record("rec-early", "10", { occurredOn: "2026-09-01" }),
        record("rec-target", "20", { occurredOn: "2026-09-05" }),
        record("rec-rev", "20", { occurredOn: "2026-09-06", reversesId: "rec-target" }),
      ],
      expected: "10",
    },
    {
      aggregation: "unique_count",
      records: [
        record("rec-a", "1", { distinctKey: "sess-1" }),
        record("rec-b", "1", { distinctKey: "sess-1" }),
        record("rec-c", "1", { distinctKey: "sess-2" }),
        record("rec-rev", "1", { reversesId: "rec-a" }),
      ],
      expected: "2",
    },
  ];
  for (const { aggregation, records, expected } of cases) {
    assert.equal(aggregateUsage(aggregation, records), expected, aggregation);
  }
});

test("last orders by occurredOn then id", () => {
  const records = [
    record("rec-02", "9", { occurredOn: "2026-09-01" }),
    record("rec-01", "5", { occurredOn: "2026-09-01" }),
  ];
  assert.equal(aggregateUsage("last", records), "9");
  assert.equal(
    aggregateUsage("last", [...records, record("rec-rev", "9", { reversesId: "rec-02" })]),
    "5",
  );
});

test("empty windows aggregate to zero under every arm", () => {
  const aggregations: UsageAggregation[] = ["sum", "count", "max", "last", "unique_count"];
  for (const aggregation of aggregations) {
    assert.equal(aggregateUsage(aggregation, []), "0", aggregation);
  }
});

test("graduated prices each unit in its band, with per-tier flat fees", () => {
  const lines = rateUsage({
    quantity: parseQuantity("650"),
    bands: [
      band(1, "100", "0.1"),
      band(2, "500", "0.08", { flatAmount: "5.0000" }),
      band(3, null, "0.05"),
    ],
  });
  assert.deepEqual(lines, [
    { kind: "graduated", bandSeq: 1, quantity: "100", unitPrice: "0.1", amount: "10.0000" },
    { kind: "graduated", bandSeq: 2, quantity: "400", unitPrice: "0.08", amount: "32.0000" },
    { kind: "graduated", bandSeq: 2, quantity: "1", unitPrice: "5", amount: "5.0000" },
    { kind: "graduated", bandSeq: 3, quantity: "150", unitPrice: "0.05", amount: "7.5000" },
  ]);
  assert.equal(sum(lines.map((line) => line.amount)), "54.5000");
});

// upToQty is inclusive: a quantity exactly on a boundary belongs to the lower band.
test("volume prices everything at the landed band, boundary included below", () => {
  const bands = [band(1, "100", "0.1", { kind: "volume" }), band(2, null, "0.08", { kind: "volume" })];
  assert.deepEqual(rateUsage({ quantity: parseQuantity("100"), bands }), [
    { kind: "volume", bandSeq: 1, quantity: "100", unitPrice: "0.1", amount: "10.0000" },
  ]);
  assert.deepEqual(rateUsage({ quantity: parseQuantity("101"), bands }), [
    { kind: "volume", bandSeq: 2, quantity: "101", unitPrice: "0.08", amount: "8.0800" },
  ]);
});

test("package bills whole blocks, rounding the partial block up or down", () => {
  const up: RatingBand = { ...band(1, null, "12", { kind: "package", packageSize: "100" }), packageRounding: "up" };
  const down: RatingBand = { ...band(1, null, "12", { kind: "package", packageSize: "100" }), packageRounding: "down" };
  assert.deepEqual(rateUsage({ quantity: parseQuantity("250"), bands: [up] }), [
    { kind: "package", bandSeq: 1, quantity: "3", unitPrice: "12", amount: "36.0000" },
  ]);
  assert.deepEqual(rateUsage({ quantity: parseQuantity("250"), bands: [down] }), [
    { kind: "package", bandSeq: 1, quantity: "2", unitPrice: "12", amount: "24.0000" },
  ]);
  assert.deepEqual(rateUsage({ quantity: parseQuantity("50"), bands: [down] }), []);
});

test("overage bills only the excess above the included quantity", () => {
  const bands = [band(1, null, "0.05", { kind: "overage", includedQty: "100" })];
  assert.deepEqual(rateUsage({ quantity: parseQuantity("150"), bands }), [
    { kind: "overage", bandSeq: 1, quantity: "50", unitPrice: "0.05", amount: "2.5000" },
  ]);
  assert.deepEqual(rateUsage({ quantity: parseQuantity("100"), bands }), []);
});

test("a sub-cent price rounds once per line, and lines sum to the total", () => {
  const lines = rateUsage({
    quantity: parseQuantity("1234567"),
    bands: [band(1, null, "0.00015000", { kind: "volume" })],
  });
  assert.deepEqual(lines, [
    { kind: "volume", bandSeq: 1, quantity: "1234567", unitPrice: "0.00015", amount: "185.1851" },
  ]);
  assert.equal(sum(lines.map((line) => line.amount)), "185.1851");
});

test("zero quantity rates to no lines", () => {
  assert.deepEqual(
    rateUsage({ quantity: parseQuantity("0"), bands: [band(1, "100", "0.1"), band(2, null, "0.05")] }),
    [],
  );
});

test("prices beyond 8 decimal places are refused by name", () => {
  assert.throws(
    () =>
      rateUsage({
        quantity: parseQuantity("10"),
        bands: [{ ...band(1, null, "0.1"), unitPrice: "0.123456789" as Rate }],
      }),
    /rating band 1 unitPrice accepts at most 8 decimal places/,
  );
});

test("commit shortfall bills the positive remainder, else zero", () => {
  assert.equal(
    commitShortfall({ commitAmount: parseMoney("100.0000"), ratedInWindow: parseMoney("75.0000") }),
    "25.0000",
  );
  assert.equal(
    commitShortfall({ commitAmount: parseMoney("100.0000"), ratedInWindow: parseMoney("120.0000") }),
    "0.0000",
  );
  assert.equal(
    commitShortfall({ commitAmount: parseMoney("100.0000"), ratedInWindow: parseMoney("100.0000") }),
    "0.0000",
  );
});

test("prepaid draws up to the balance, billing the remainder", () => {
  assert.deepEqual(
    applyPrepaid({ rated: parseMoney("100.0000"), balance: parseMoney("40.0000"), allowOverage: true }),
    { drawn: "40.0000", billable: "60.0000" },
  );
  assert.deepEqual(
    applyPrepaid({ rated: parseMoney("30.0000"), balance: parseMoney("100.0000"), allowOverage: true }),
    { drawn: "30.0000", billable: "0.0000" },
  );
});

test("prepaid shortfall with overage disallowed names all three remedies", () => {
  assert.throws(
    () => applyPrepaid({ rated: parseMoney("100.0000"), balance: parseMoney("40.0000"), allowOverage: false }),
    (error: unknown) => {
      assert.ok(error instanceof UsageBillingError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "prepaid_overage_disallowed");
      for (const remedy of [
        "top up the prepaid balance",
        "allow overage on the subscription's usage link",
        "bill the usage ad hoc",
      ]) {
        assert.match(error.message, new RegExp(remedy));
        assert.match(error.remedy, new RegExp(remedy));
      }
      return true;
    },
  );
});

test("non-invoice band kinds refuse toward their own functions", () => {
  assert.throws(
    () => rateUsage({ quantity: parseQuantity("10"), bands: [band(1, null, "0.1", { kind: "commit_shortfall" })] }),
    /bill the shortfall with commitShortfall instead/,
  );
  assert.throws(
    () => rateUsage({ quantity: parseQuantity("10"), bands: [band(1, null, "0.1", { kind: "prepaid_drawdown" })] }),
    /split the rated amount with applyPrepaid instead/,
  );
  assert.throws(
    () => aggregateUsage("bogus" as UsageAggregation, []),
    /unknown usage aggregation/,
  );
});
