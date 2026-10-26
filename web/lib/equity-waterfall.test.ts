import assert from "node:assert/strict";
import test from "node:test";
import type { WaterfallResult } from "@openbooks/engine/equity";
import { sum } from "@openbooks/engine/money/money";
import {
  apportionedPercents,
  cleanDecimal,
  conversionDecisions,
  currencyDecimalPlaces,
  curveSeries,
  decisionMessageKey,
  defaultExitAnchor,
  displayedAmounts,
  exitPresets,
  payoutLines,
  percentOf,
  waterfallSteps,
} from "./equity-waterfall";

const SA = "c0000000-0000-4000-8000-0000000000a1";
const SEED = "c0000000-0000-4000-8000-0000000000a2";
const CS = "c0000000-0000-4000-8000-0000000000a3";
const HOLDER = "b0000000-0000-4000-8000-0000000000b1";

type ClassRow = WaterfallResult["classes"][number];
const preferred = (
  shareClassId: string,
  code: string,
  seniority: number,
  values: Partial<ClassRow>,
): ClassRow => ({
  shareClassId,
  code,
  kind: "preferred",
  seniority,
  participationMode: "none",
  converted: false,
  preference: "0.0000",
  participation: "0.0000",
  total: "0.0000",
  perShare: "0.0000000000",
  preferenceEntitlement: "0.0000",
  participationCap: null,
  alternativeTotal: null,
  ...values,
});

/**
 * A 10,000,000 exit with 500,000 of fees: Series A (senior, 1x non-participating) keeps its
 * 3,000,000 preference, the Seed class converts, a capped SAFE converts, a note is repaid, and
 * common and the awards share the residual.
 */
const result: WaterfallResult = {
  exitValue: "9500000.0000",
  pricePerCommonShare: "1.0500000000",
  classes: [
    preferred(SA, "SA", 2, {
      preference: "3000000.0000",
      total: "3000000.0000",
      perShare: "3.0000000000",
      preferenceEntitlement: "3000000.0000",
      alternativeTotal: "2400000.0000",
    }),
    preferred(SEED, "SEED", 1, {
      converted: true,
      participation: "1500000.0000",
      total: "1500000.0000",
      perShare: "1.5000000000",
      preferenceEntitlement: "1000000.0000",
      alternativeTotal: "1000000.0000",
    }),
    {
      ...preferred(CS, "CS", 0, {
        participation: "4200000.0000",
        total: "4200000.0000",
        perShare: "1.0500000000",
      }),
      kind: "common",
    },
  ],
  payouts: [
    {
      securityId: "s1",
      holderPartyId: HOLDER,
      kind: "share",
      shareClassId: SA,
      amount: "3000000.0000",
    },
    {
      securityId: "s2",
      holderPartyId: HOLDER,
      kind: "share",
      shareClassId: SEED,
      amount: "1500000.0000",
    },
    {
      securityId: "s3",
      holderPartyId: HOLDER,
      kind: "share",
      shareClassId: CS,
      amount: "4200000.0000",
    },
    {
      securityId: "o1",
      holderPartyId: HOLDER,
      kind: "award",
      shareClassId: CS,
      amount: "500000.0000",
    },
    {
      securityId: "f1",
      holderPartyId: HOLDER,
      kind: "safe",
      shareClassId: null,
      amount: "200000.0000",
    },
    {
      securityId: "n1",
      holderPartyId: HOLDER,
      kind: "note",
      shareClassId: null,
      amount: "100000.0000",
    },
  ],
  holders: [{ holderPartyId: HOLDER, amount: "9500000.0000", percent: "100.0000" }],
  safes: [
    {
      securityId: "f1",
      holderPartyId: HOLDER,
      converted: true,
      shares: "190476.1904761905",
      amount: "200000.0000",
      cashOutAmount: "150000.0000",
      alternativeAmount: "150000.0000",
    },
  ],
  unallocated: "0.0000",
};

test("the waterfall opens on the latest priced round in the functional currency, with exact preset multiples", () => {
  const rounds = [
    {
      name: "Series Seed",
      closedOn: "2024-06-28",
      currency: "USD",
      preMoneyValuation: "9000000.0000",
      raised: "3600000.0000",
    },
    {
      name: "Series A",
      closedOn: "2025-09-30",
      currency: "USD",
      preMoneyValuation: "53200000.0000",
      raised: "14000000.0000",
    },
    {
      name: "Bridge (EUR)",
      closedOn: "2026-01-15",
      currency: "EUR",
      preMoneyValuation: "70000000.0000",
      raised: "2000000.0000",
    },
    {
      name: "Series B",
      closedOn: "2026-11-01",
      currency: "USD",
      preMoneyValuation: "150000000.0000",
      raised: "30000000.0000",
    },
  ];
  const anchor = defaultExitAnchor(rounds, "2026-10-18", "USD");
  assert.deepEqual(
    anchor,
    { roundName: "Series A", closedOn: "2025-09-30", postMoney: "67200000.0000" },
    "a later or foreign-currency round never anchors the default",
  );
  assert.deepEqual(exitPresets(anchor!.postMoney), [
    { multiple: "0.5", value: "33600000.0000" },
    { multiple: "1", value: "67200000.0000" },
    { multiple: "2", value: "134400000.0000" },
    { multiple: "5", value: "336000000.0000" },
  ]);
  assert.equal(
    defaultExitAnchor(rounds, "2024-01-01", "USD"),
    null,
    "no round yet: the page asks for an exit value",
  );
  assert.deepEqual(exitPresets(null), []);
  assert.deepEqual(exitPresets("0.0000"), []);
});

test("the payment cascade runs fees, notes, preferences by seniority, then the residual, and sums to the exit value", () => {
  const steps = waterfallSteps(result, "500000.0000");
  assert.deepEqual(
    steps.map((step) => [step.kind, step.code, step.amount]),
    [
      ["fees", null, "500000.0000"],
      ["notes", null, "100000.0000"],
      ["preference", "SA", "3000000.0000"],
      ["participation", "SEED", "1500000.0000"],
      ["participation", "CS", "4200000.0000"],
      ["safe_conversion", null, "200000.0000"],
      ["awards", null, "500000.0000"],
    ],
  );
  assert.equal(
    sum(steps.map((step) => step.amount)),
    "10000000.0000",
    "the cascade accounts for every unit of the gross exit",
  );
});

test("payout lines by recipient sum to the proceeds and carry each class election", () => {
  const lines = payoutLines(result);
  assert.deepEqual(
    lines.map((line) => line.key),
    [`class:${SA}`, `class:${SEED}`, `class:${CS}`, "awards", "safes", "notes"],
  );
  assert.equal(sum(lines.map((line) => line.total)), result.exitValue);
  assert.deepEqual(
    lines.slice(0, 3).map((line) => line.converted),
    [false, true, null],
    "common has no election",
  );
  assert.equal(lines[0]!.percent, "31.58");
  assert.equal(percentOf("1", "3"), "33.33");
  assert.equal(percentOf("2", "3"), "66.67");
  assert.equal(percentOf("5", "0"), null, "nothing distributed: no part has a share");
  assert.equal(
    sum(lines.map((line) => line.percent ?? "0")),
    "100.0000",
    "the shares of the exit add up to 100.00",
  );
});

test("each elector shows its choice with the amount the other choice would pay", () => {
  assert.deepEqual(
    conversionDecisions(result).map((row) => [
      row.code ?? row.securityId,
      row.decision,
      row.amount,
      row.entitlement,
      row.alternative,
    ]),
    [
      ["SA", "keeps_preference", "3000000.0000", "3000000.0000", "2400000.0000"],
      ["SEED", "converts", "1500000.0000", "1000000.0000", "1000000.0000"],
      ["f1", "safe_converts", "200000.0000", "150000.0000", "150000.0000"],
    ],
  );
  assert.deepEqual(
    conversionDecisions(result).map((row) => [row.paid, row.coverage, decisionMessageKey(row)]),
    [
      ["3000000.0000", "full", "keeps_preference"],
      [null, null, "converts"],
      [null, null, "safe_converts"],
    ],
  );
});

test("the proceeds curve has one series per recipient that is ever paid, senior preferred first", () => {
  const zero: WaterfallResult = {
    ...result,
    exitValue: "0.0000",
    classes: result.classes.map((row) => ({ ...row, total: "0.0000" })),
    payouts: result.payouts.map((row) => ({ ...row, amount: "0.0000" })),
  };
  const { exitValues, series } = curveSeries([
    { exitValue: "0.0000", result: zero },
    { exitValue: "10000000.0000", result },
  ]);
  assert.deepEqual(exitValues, ["0.0000", "10000000.0000"]);
  assert.deepEqual(
    series.map((row) => [row.key, row.code, row.data]),
    [
      [`class:${SA}`, "SA", ["0.0000", "3000000.0000"]],
      [`class:${SEED}`, "SEED", ["0.0000", "1500000.0000"]],
      [`class:${CS}`, "CS", ["0.0000", "4200000.0000"]],
      ["awards", null, ["0.0000", "500000.0000"]],
      ["safes", null, ["0.0000", "200000.0000"]],
      ["notes", null, ["0.0000", "100000.0000"]],
    ],
  );
  assert.deepEqual(
    curveSeries([{ exitValue: "0.0000", result: zero }]).series,
    [],
    "a recipient never paid draws no line",
  );
});

test("exit values read as an operator types them, never as raw four-place ledger text", () => {
  assert.equal(cleanDecimal("67316585.6000"), "67316585.6");
  assert.equal(cleanDecimal("67200000.0000"), "67200000");
  assert.equal(cleanDecimal("0.0000"), "0");
  assert.equal(cleanDecimal("1250.0500"), "1250.05");
  assert.equal(cleanDecimal(""), "");
  assert.equal(
    cleanDecimal("12abc"),
    "12abc",
    "text that is not a decimal is left for the input to refuse",
  );
  assert.deepEqual(
    exitPresets("67316585.6000").map((preset) => cleanDecimal(preset.value)),
    ["33658292.8", "67316585.6", "134633171.2", "336582928"],
  );
});

test("a row shows parts that add up to its total, even when the engine rounds them independently", () => {
  // The engine rounds the preference and participation half up on their own
  // and the class total by largest remainder across holdings, so the raw
  // parts can sit one unit away from the total.
  const rounded: WaterfallResult = {
    ...result,
    exitValue: "9500000.0000",
    classes: [
      preferred(SA, "SA", 2, {
        participationMode: "full",
        preference: "3000000.0000",
        participation: "1387831.4600",
        total: "4387831.4700",
        preferenceEntitlement: "3000000.0000",
      }),
      {
        ...preferred(CS, "CS", 0, { participation: "5112168.5300", total: "5112168.5300" }),
        kind: "common",
      },
    ],
    payouts: [],
    safes: [],
  };
  const lines = payoutLines(rounded);
  assert.deepEqual(
    lines.map((line) => [line.preference, line.participation, line.total]),
    [
      ["3000000.0000", "1387831.4700", "4387831.4700"],
      [null, "5112168.5300", "5112168.5300"],
    ],
  );
  for (const line of lines) {
    const shown = displayedAmounts(line, 2);
    assert.equal(
      sum([shown.preference ?? "0", shown.participation ?? "0"]),
      shown.total,
      "the shown parts make up the shown total",
    );
  }
  // Four-place parts shown at two places: the total and the preference round, the participation is the rest.
  assert.deepEqual(
    displayedAmounts(
      { preference: "6073719.6049", participation: "1000.0049", total: "6074719.6098" },
      2,
    ),
    {
      preference: "6073719.6000",
      participation: "1000.0100",
      total: "6074719.6100",
    },
  );
  assert.deepEqual(
    displayedAmounts({ preference: "10.0000", participation: "0.0000", total: "9.9950" }, 0),
    { preference: "10.0000", participation: "0.0000", total: "10.0000" },
  );
  assert.deepEqual(
    displayedAmounts({ preference: null, participation: null, total: "4413124.8250" }, 2),
    { preference: null, participation: null, total: "4413124.8300" },
  );
  assert.equal(currencyDecimalPlaces("USD"), 2);
  assert.equal(currencyDecimalPlaces("JPY"), 0);
});

test("shares of the exit add up to 100.00 and are undefined when nothing is distributed", () => {
  assert.deepEqual(apportionedPercents(["1.0000", "1.0000", "1.0000"], "3.0000"), [
    "33.34",
    "33.33",
    "33.33",
  ]);
  assert.deepEqual(apportionedPercents(["0.0000", "0.0000"], "0.0000"), [null, null]);
  const zero: WaterfallResult = {
    ...result,
    exitValue: "0.0000",
    classes: result.classes.map((row) => ({
      ...row,
      preference: "0.0000",
      participation: "0.0000",
      total: "0.0000",
    })),
    payouts: result.payouts.map((row) => ({ ...row, amount: "0.0000" })),
    safes: result.safes.map((row) => ({ ...row, amount: "0.0000" })),
  };
  assert.ok(
    payoutLines(zero).every((line) => line.percent === null),
    "a zero exit gives no recipient a share",
  );
});

test("a preference the proceeds cover in part or not at all is described by what was paid", () => {
  const short = (preference: string, total: string): WaterfallResult => ({
    ...result,
    exitValue: total,
    classes: [
      preferred(SA, "SA", 2, {
        preference,
        total,
        preferenceEntitlement: "14000000.0000",
        alternativeTotal: "0.0000",
      }),
    ],
    payouts: [],
    safes: [
      {
        securityId: "f1",
        holderPartyId: HOLDER,
        converted: false,
        shares: "0.0000000000",
        amount: "0.0000",
        cashOutAmount: "150000.0000",
        alternativeAmount: null,
      },
    ],
  });
  const partly = conversionDecisions(short("10000000.0000", "10000000.0000"));
  assert.deepEqual(
    partly.map((row) => [row.paid, row.coverage, decisionMessageKey(row)]),
    [
      ["10000000.0000", "partial", "keeps_preference_partial"],
      ["0.0000", "none", "safe_cash_out_none_only"],
    ],
  );
  const nothing = conversionDecisions(short("0.0000", "0.0000"));
  assert.deepEqual(nothing.map((row) => [row.coverage, decisionMessageKey(row)])[0], [
    "none",
    "keeps_preference_none",
  ]);
  assert.equal(
    decisionMessageKey({ decision: "participates", coverage: "partial", alternative: null }),
    "participates_partial",
  );
  assert.equal(
    decisionMessageKey({ decision: "participates_capped", coverage: "full", alternative: null }),
    "participates_capped_only",
  );
  assert.equal(
    decisionMessageKey({ decision: "safe_cash_out", coverage: "partial", alternative: "1.0000" }),
    "safe_cash_out_partial",
  );
});
