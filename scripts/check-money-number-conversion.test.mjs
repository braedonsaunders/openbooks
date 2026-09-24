import assert from "node:assert/strict";
import test from "node:test";
import { scanMoneyNumberConversions } from "./check-money-number-conversion.mjs";

test("money conversion check catches decimal DTO amounts coerced to Number", () => {
  const violations = scanMoneyNumberConversions(`
    function render(row) { return format.number(Number(row.rate)); }
    function label(entry) { return Intl.NumberFormat(locale).format(Number(entry['balance'])); }
  `, "web/components/money-fixture.tsx");
  assert.deepEqual(violations.map(({ field }) => field), ["rate", "balance"]);
});

test("money conversion check catches exact money arithmetic converted back to float", () => {
  const violations = scanMoneyNumberConversions(`
    function balances(row) { return Number(mulDecimal(row.balance, row.fx)); }
    async function pipelineInOrgCurrency() { const total = add('0', '1'); return Number(total); }
  `, "web/lib/module-home/customers.ts");
  assert.deepEqual(violations.map(({ field }) => field), [null, null]);
});

test("money conversion check allows non-money quantities and exact formatter input", () => {
  const violations = scanMoneyNumberConversions(`
    function render(row) { return [format.number(Number(row.hours)), money(row.amount)]; }
  `, "web/components/money-fixture.tsx");
  assert.deepEqual(violations, []);
});
