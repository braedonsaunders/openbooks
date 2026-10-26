import assert from "node:assert/strict";
import test from "node:test";
import { AssetRefusal } from "./asset-refusal.ts";
import { buildCapitalizationLines, cipOpenBalance, planCapitalization } from "./cip-math.ts";

function refusedWith(code: string, fn: () => void): void {
  assert.throws(fn, (error: unknown) => error instanceof AssetRefusal && error.code === code);
}

test("the open balance is linked cost less posted capitalizations; unlinked and reversed rows drop out", () => {
  const balance = cipOpenBalance(
    [
      { amount: "120000.00", status: "linked" },
      { amount: "-2000.00", status: "linked" },
      { amount: "5000.00", status: "unlinked" },
    ],
    [
      { capitalizedAmount: "90000", expensedAmount: "3000", status: "posted" },
      { capitalizedAmount: "10000", expensedAmount: "0", status: "reversed" },
    ],
  );
  assert.deepEqual(balance, {
    linked: "118000.0000",
    capitalized: "90000.0000",
    expensed: "3000.0000",
    open: "25000.0000",
  });
});

test("a partial capitalization leaves the rest open; more than the balance is refused", () => {
  assert.deepEqual(
    planCapitalization("25000", [
      { kind: "asset", amount: "18000" },
      { kind: "component", amount: "4000" },
      { kind: "expense", amount: "1000" },
    ]),
    {
      capitalized: "22000.0000",
      expensed: "1000.0000",
      total: "23000.0000",
      remaining: "2000.0000",
    },
  );
  assert.equal(
    planCapitalization("25000", [{ kind: "asset", amount: "25000" }]).remaining,
    "0.0000",
  );
  refusedWith("capitalization_exceeds_balance", () =>
    planCapitalization("25000", [{ kind: "asset", amount: "25000.01" }]),
  );
  refusedWith("capitalization_lines_required", () => planCapitalization("25000", []));
  refusedWith("amount_not_positive", () =>
    planCapitalization("25000", [{ kind: "expense", amount: "0" }]),
  );
});

test("the capitalization journal debits each target and credits CIP for the total", () => {
  const lines = buildCapitalizationLines(
    "acct-cip",
    [
      { targetAccountId: "acct-buildings", amount: "18000", memo: "Warehouse" },
      { targetAccountId: "acct-repairs", amount: "1000.50", memo: "Non-capitalizable" },
    ],
    "Capitalize CIP-1",
  );
  assert.deepEqual(lines, [
    { accountId: "acct-buildings", amount: "18000.0000", memo: "Warehouse" },
    { accountId: "acct-repairs", amount: "1000.5000", memo: "Non-capitalizable" },
    { accountId: "acct-cip", amount: "-19000.5000", memo: "Capitalize CIP-1" },
  ]);
  refusedWith("capitalization_target_is_cip", () =>
    buildCapitalizationLines(
      "acct-cip",
      [{ targetAccountId: "acct-cip", amount: "1", memo: "x" }],
      "m",
    ),
  );
});
