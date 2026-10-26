import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountingContextError,
  assertUniqueLocalizedNumbers,
  compareAccountLabels,
  type AccountLabel,
} from "./accounting-contexts.ts";

const label = (number: string | null, name: string, localized = true): AccountLabel => ({
  number,
  name,
  localized,
});

test("localized numbers sort in natural order, then by name, with unnumbered accounts last", () => {
  const rows = [
    label("10", "Ten"),
    label("2", "Two"),
    label(null, "Unnumbered"),
    label("2", "Another two"),
    label("100", "Hundred"),
  ];
  assert.deepEqual(
    [...rows].sort(compareAccountLabels).map((row) => row.name),
    ["Another two", "Two", "Ten", "Hundred", "Unnumbered"],
  );
});

test("two accounts sharing a localized number refuse the context, whatever the case", () => {
  const labels = new Map([
    ["a", label("411A", "Clients")],
    ["b", label("411a", "Clients export")],
  ]);
  assert.throws(
    () => assertUniqueLocalizedNumbers(labels, { name: "PCG" }),
    (error: unknown) =>
      error instanceof AccountingContextError &&
      error.code === "accounting_context_ambiguous" &&
      /411a/i.test(error.message),
  );
});

test("base-chart fallbacks never collide with localized numbers", () => {
  const labels = new Map([
    ["a", label("4000", "Sales", false)],
    ["b", label("4000", "Ventes")],
  ]);
  assert.doesNotThrow(() => assertUniqueLocalizedNumbers(labels, { name: "PCG" }));
});
