import assert from "node:assert/strict";
import test from "node:test";
import { formatGroupedMoney, sumByCurrency } from "./portfolio-money";

test("property portfolio amounts add exactly within each currency", () => {
  const totals = sumByCurrency([
    { currency: "USD", amount: "0.1000" },
    { currency: "USD", amount: "0.2000" },
    { currency: "CAD", amount: "3.2500" },
  ]);
  assert.deepEqual(totals, [
    { currency: "CAD", total: "3.2500" },
    { currency: "USD", total: "0.3000" },
  ]);
  assert.equal(
    formatGroupedMoney(totals, (value, options) => `${options?.currency} ${value}`),
    "CAD 3.2500 · USD 0.3000",
  );
});

test("property portfolio totals refuse amounts without a configured currency", () => {
  assert.throws(() => sumByCurrency([{ currency: "", amount: "1.00" }]), /currency is required/);
});
