import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LaborCostCatchUpRefusal,
  normalizeCatchUpReason,
  summarizeMonthState,
  summarizeUnpostedRows,
  type UnpostedLaborRow,
} from "./labor-cost-catch-up.ts";

test("catch-up reason is trimmed and must be a meaningful audit explanation", () => {
  assert.equal(normalizeCatchUpReason("  Cost backlog from June  "), "Cost backlog from June");
  assert.throws(
    () => normalizeCatchUpReason(" abcd "),
    (error: unknown) =>
      error instanceof LaborCostCatchUpRefusal &&
      error.code === "reason_invalid" &&
      error.status === 422 &&
      error.remedy.length > 0,
  );
  assert.throws(
    () => normalizeCatchUpReason("x".repeat(501)),
    (error: unknown) => error instanceof LaborCostCatchUpRefusal && error.code === "reason_invalid",
  );
});

test("a month is open or closed only when all of its entries agree, otherwise partial", () => {
  assert.equal(summarizeMonthState(["open", "open"]), "open");
  assert.equal(summarizeMonthState(["closed"]), "closed");
  assert.equal(summarizeMonthState(["no_period", "no_period"]), "no_period");
  assert.equal(summarizeMonthState(["open", "closed"]), "partial");
});

test("totals keep currencies separate and add exact four-decimal costs", () => {
  const rows: UnpostedLaborRow[] = [
    { id: "a", hours: "1.5000", cost: "37.5000", currency: "CAD", month: "2026-07", state: "open" },
    { id: "b", hours: "2.0000", cost: "0.0001", currency: "CAD", month: "2026-07", state: "open" },
    {
      id: "c",
      hours: "1.0000",
      cost: "20.0000",
      currency: "USD",
      month: "2026-06",
      state: "closed",
    },
  ];
  const { months, totals } = summarizeUnpostedRows(rows);
  assert.deepEqual(months, [
    {
      month: "2026-06",
      entries: 1,
      hours: "1.0000",
      costs: [{ currency: "USD", amount: "20.0000" }],
      state: "closed",
      blockedEntries: 1,
    },
    {
      month: "2026-07",
      entries: 2,
      hours: "3.5000",
      costs: [{ currency: "CAD", amount: "37.5001" }],
      state: "open",
      blockedEntries: 0,
    },
  ]);
  assert.deepEqual(totals, {
    entries: 3,
    postableEntries: 2,
    blockedEntries: 1,
    hours: "4.5000",
    costs: [
      { currency: "CAD", amount: "37.5001" },
      { currency: "USD", amount: "20.0000" },
    ],
  });
});

test("an empty backlog reports canonical zero totals", () => {
  assert.deepEqual(summarizeUnpostedRows([]), {
    months: [],
    totals: { entries: 0, postableEntries: 0, blockedEntries: 0, hours: "0.0000", costs: [] },
  });
});
