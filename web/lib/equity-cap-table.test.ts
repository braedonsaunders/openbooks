import assert from "node:assert/strict";
import test from "node:test";
import type { CapTable } from "@openbooks/engine/equity";
import {
  capTableFilters,
  capTableLayout,
  exactPercent,
  parseDimension,
  parseInstrument,
} from "./equity-cap-table";

const COMMON = "c0000000-0000-4000-8000-000000000001";
const SERIES = "c0000000-0000-4000-8000-000000000002";
const FOUNDER = "b0000000-0000-4000-8000-000000000001";
const INVESTOR = "b0000000-0000-4000-8000-000000000002";
const EMPLOYEE = "b0000000-0000-4000-8000-000000000003";

const classRow = (
  shareClassId: string,
  code: string,
  kind: "common" | "preferred",
  values: Partial<CapTable["classes"][number]>,
): CapTable["classes"][number] => ({
  shareClassId,
  code,
  name: code,
  kind,
  seniority: kind === "preferred" ? 1 : 0,
  authorized: "10000000",
  outstanding: "0",
  asConvertedOutstanding: "0",
  awardsOutstanding: "0",
  poolAvailable: "0",
  fullyDiluted: "0",
  conversionRatio: "1.0000000000",
  parValue: "0.0001000000",
  originalIssuePrice: null,
  conversionPrice: null,
  outstandingPercent: "0.0000",
  fullyDilutedPercent: "0.0000",
  ...values,
});

const holding = (
  securityId: string,
  kind: "share" | "option" | "rsu" | "warrant",
  holderPartyId: string,
  shareClassId: string,
  outstanding: string,
  vested: string,
): CapTable["holdings"][number] => ({
  securityId,
  securityNumber: securityId,
  kind,
  holderPartyId,
  shareClassId,
  planId: null,
  status: "outstanding",
  outstanding,
  vested,
  unvested: (BigInt(outstanding) - BigInt(vested)).toString(),
  asConverted: outstanding,
  exercisePrice: null,
});

/** Founder common, investor preferred, an employee option and RSU, an investor warrant and an unallocated pool. */
const table: CapTable = {
  asOf: "2026-10-18",
  classes: [
    classRow(COMMON, "CS", "common", {
      outstanding: "4000000",
      asConvertedOutstanding: "4000000",
      awardsOutstanding: "60000",
      poolAvailable: "440000",
      fullyDiluted: "4510000",
      outstandingPercent: "80.0000",
      fullyDilutedPercent: "81.8512",
    }),
    classRow(SERIES, "SA", "preferred", {
      outstanding: "1000000",
      asConvertedOutstanding: "1000000",
      fullyDiluted: "1000000",
      outstandingPercent: "20.0000",
      fullyDilutedPercent: "18.1488",
    }),
  ],
  holders: [
    {
      holderPartyId: FOUNDER,
      sharesByClass: { [COMMON]: "4000000" },
      asConvertedOutstanding: "4000000",
      options: "0",
      rsus: "0",
      warrants: "0",
      vestedAwards: "0",
      fullyDiluted: "4000000",
      outstandingPercent: "80.0000",
      fullyDilutedPercent: "72.5953",
    },
    {
      holderPartyId: INVESTOR,
      sharesByClass: { [SERIES]: "1000000" },
      asConvertedOutstanding: "1000000",
      options: "0",
      rsus: "0",
      warrants: "10000",
      vestedAwards: "10000",
      fullyDiluted: "1010000",
      outstandingPercent: "20.0000",
      fullyDilutedPercent: "18.3303",
    },
    {
      holderPartyId: EMPLOYEE,
      sharesByClass: {},
      asConvertedOutstanding: "0",
      options: "48000",
      rsus: "2000",
      warrants: "0",
      vestedAwards: "12000",
      fullyDiluted: "50000",
      outstandingPercent: "0.0000",
      fullyDilutedPercent: "0.9074",
    },
  ],
  unallocatedPool: { fullyDiluted: "440000", fullyDilutedPercent: "7.9855" },
  plans: [],
  holdings: [
    holding("s1", "share", FOUNDER, COMMON, "4000000", "4000000"),
    holding("s2", "share", INVESTOR, SERIES, "1000000", "1000000"),
    holding("o1", "option", EMPLOYEE, COMMON, "48000", "12000"),
    holding("r1", "rsu", EMPLOYEE, COMMON, "2000", "0"),
    holding("w1", "warrant", INVESTOR, COMMON, "10000", "10000"),
  ],
  convertibles: [],
  totals: {
    outstanding: "5000000",
    asConvertedOutstanding: "5000000",
    awardsOutstanding: "60000",
    poolAvailable: "440000",
    fullyDiluted: "5510000",
  },
};

test("the view and instrument filters default to every instrument by class and ignore unknown values", () => {
  assert.equal(parseDimension(undefined), "class");
  assert.equal(parseDimension("holder"), "holder");
  assert.equal(parseDimension("security"), "class");
  assert.equal(parseInstrument("option"), "option");
  assert.equal(
    parseInstrument("safe"),
    "all",
    "convertibles are not fully diluted shares; the register filters them",
  );
});

test("by class across every instrument, the totals reconcile to the fully diluted capitalization", () => {
  const layout = capTableLayout(table, { dimension: "class", instrument: "all", query: "" });
  assert.deepEqual(
    layout.columns.map((column) => column.key),
    [
      "authorized",
      "outstanding",
      "asConverted",
      "awards",
      "pool",
      "fullyDiluted",
      "outstandingPercent",
      "fullyDilutedPercent",
    ],
  );
  assert.deepEqual(
    layout.lines.map((line) => line.shareClassId),
    [COMMON, SERIES],
  );
  assert.equal(layout.totals.fullyDiluted, table.totals.fullyDiluted);
  assert.equal(layout.totals.pool, table.totals.poolAvailable);
  assert.equal(layout.totals.authorized, "20000000", "the total authorized across the classes");
  // Percentages are the lines' share of the whole table from exact counts,
  // never a sum of rounded line percentages.
  assert.equal(layout.totals.outstandingPercent, "100.0000");
  assert.equal(layout.totals.fullyDilutedPercent, "100.0000");
  const seriesOnly = capTableLayout(table, { dimension: "class", instrument: "all", query: "sa" });
  assert.equal(
    seriesOnly.totals.outstandingPercent,
    "20.0000",
    "a filtered table totals the share it shows",
  );
  assert.equal(seriesOnly.totals.fullyDilutedPercent, exactPercent(1_000_000n, 5_510_000n));
});

test("an exact percentage rounds half up to four places without crossing a float", () => {
  assert.equal(exactPercent(1n, 3n), "33.3333");
  assert.equal(exactPercent(2n, 3n), "66.6667");
  assert.equal(exactPercent(1n, 80_000_000n), "0.0000");
  assert.equal(exactPercent(1n, 20_000n), "0.0050");
  assert.equal(exactPercent(9_007_199_254_740_993n, 9_007_199_254_740_993n), "100.0000");
  assert.equal(exactPercent(5n, 0n), "0.0000", "an empty table has no share to give");
});

test("one award kind by class or holder lists only who holds it, with its vested and unvested units", () => {
  const byClass = capTableLayout(table, { dimension: "class", instrument: "option", query: "" });
  assert.deepEqual(
    byClass.columns.map((column) => column.key),
    ["instrumentOutstanding", "vested", "unvested"],
  );
  assert.deepEqual(
    byClass.lines.map((line) => [line.shareClassId, line.values]),
    [[COMMON, { instrumentOutstanding: "48000", vested: "12000", unvested: "36000" }]],
  );
  const byHolder = capTableLayout(table, { dimension: "holder", instrument: "warrant", query: "" });
  assert.deepEqual(
    byHolder.lines.map((line) => line.holderPartyId),
    [INVESTOR],
  );
  assert.equal(byHolder.totals.instrumentOutstanding, "10000");
  assert.deepEqual(
    capTableLayout(table, { dimension: "holder", instrument: "rsu", query: "" }).lines.map(
      (line) => line.values.unvested,
    ),
    ["2000"],
  );
});

test("shares by holder show each class column and leave out holders with only awards", () => {
  const layout = capTableLayout(table, { dimension: "holder", instrument: "share", query: "" });
  assert.deepEqual(
    layout.columns.map((column) => column.key),
    [`class:${COMMON}`, `class:${SERIES}`, "asConverted", "outstandingPercent"],
  );
  assert.deepEqual(
    layout.lines.map((line) => line.holderPartyId),
    [FOUNDER, INVESTOR],
  );
  assert.equal(layout.totals[`class:${COMMON}`], "4000000");
  assert.equal(layout.totals.asConverted, table.totals.asConvertedOutstanding);
  const everything = capTableLayout(table, { dimension: "holder", instrument: "all", query: "" });
  assert.equal(everything.lines.length, 4, "every holder, then the unallocated pool");
  const pool = everything.lines.at(-1)!;
  assert.equal(pool.pool, true);
  assert.deepEqual(
    [pool.holderPartyId, pool.values.fullyDiluted, pool.values.fullyDilutedPercent],
    [null, "440000", "7.9855"],
  );
  assert.equal(everything.totals.options, "48000");
  assert.equal(
    everything.totals.fullyDiluted,
    "5500000",
    "holders and the pool total the fully diluted shares",
  );
  assert.equal(
    layout.lines.some((line) => line.pool),
    false,
    "shares outstanding carry no pool line",
  );
});

test("a search keeps the matching classes or holders and totals what remains", () => {
  const parties = { [FOUNDER]: "Founder One", [INVESTOR]: "Seed Fund", [EMPLOYEE]: "Employee One" };
  const holders = capTableLayout(table, capTableFilters({ by: "holder", q: "  one " }), parties);
  assert.deepEqual(
    holders.lines.map((line) => line.holderPartyId),
    [FOUNDER, EMPLOYEE],
    "case-folded substring of the holder name; the pool names no holder",
  );
  assert.equal(holders.totals.fullyDiluted, "4050000");
  const classes = capTableLayout(table, capTableFilters({ q: "sa" }), parties);
  assert.deepEqual(
    classes.lines.map((line) => line.shareClassId),
    [SERIES],
    "the class code or name matches",
  );
  assert.equal(classes.totals.fullyDiluted, "1000000");
  assert.deepEqual(capTableFilters({ by: "holder", instrument: "rsu", q: null }), {
    dimension: "holder",
    instrument: "rsu",
    query: "",
  });
});
