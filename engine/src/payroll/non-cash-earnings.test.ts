import assert from "node:assert/strict";
import test from "node:test";
import { parseMoney } from "../money/brands.ts";
import { protectedBase } from "./limits.ts";
import { cashGrossEarnings, nonCashEarnings } from "./non-cash-earnings.ts";

const lines = [
  { kind: "earning" as const, amount: parseMoney("2400"), paymentKind: "cash" as const },
  { kind: "earning" as const, amount: parseMoney("100"), paymentKind: "non_cash" as const },
  { kind: "deduction" as const, amount: parseMoney("300") },
];

test("non-cash benefits increase reported gross without increasing cash entitlement", () => {
  assert.equal(nonCashEarnings(lines), "100.0000");
  assert.equal(cashGrossEarnings("2500", lines), "2400.0000");
});

test("non-cash valuation retains exact precision and signed corrections", () => {
  const corrections = [{ kind: "earning" as const, amount: parseMoney("-12.3456"), paymentKind: "non_cash" as const }];
  assert.equal(nonCashEarnings(corrections), "-12.3456");
  assert.equal(cashGrossEarnings("1987.6544", corrections), "2000.0000");
});

test("legacy cash lines retain the same entitlement", () => {
  assert.equal(cashGrossEarnings("2400", [{ kind: "earning", amount: parseMoney("2400") }]), "2400.0000");
});

test("employer accruals do not subtract from employee cash", () => {
  assert.equal(nonCashEarnings([{ kind: "earning", amount: parseMoney("100"), paymentKind: "non_cash", accrualOnly: true }]), "0.0000");
});

test("take-home protection cannot treat non-cash benefits as available cash", () => {
  assert.equal(protectedBase("net_pay", lines), "2100.0000");
  assert.equal(protectedBase("disposable_earnings", lines), "2100.0000");
});

test("a configured gross protection basis keeps its independent reported-gross meaning", () => {
  assert.equal(protectedBase("gross", lines), "2500.0000");
});
