import assert from "node:assert/strict";
import test from "node:test";
import { AssetLifecycleError, computeDisposal, type DisposalAccounts } from "./asset-lifecycle.ts";
import { add, isZero } from "./money.ts";

const acc: DisposalAccounts = {
  assetAccountId: "asset",
  accumulatedDepreciationAccountId: "accum",
  gainLossAccountId: "gl",
  proceedsAccountId: "cash",
};
const amt = (r: { lines: { accountId: string; amount: string }[] }, id: string) =>
  r.lines.find((l) => l.accountId === id)?.amount ?? null;

test("gain on sale: proceeds above NBV credit the gain/loss account", () => {
  // cost 10000, accum 6000 → NBV 4000; proceeds 5000 → gain 1000.
  const r = computeDisposal({ cost: "10000", accumulated: "6000", proceeds: "5000", accounts: acc });
  assert.equal(r.nbv, "4000.0000");
  assert.equal(r.gainLoss, "1000.0000");
  assert.equal(amt(r, "asset"), "-10000.0000"); // clear cost (credit)
  assert.equal(amt(r, "accum"), "6000.0000"); // clear accumulated (debit)
  assert.equal(amt(r, "cash"), "5000.0000"); // proceeds (debit)
  assert.equal(amt(r, "gl"), "-1000.0000"); // gain is a credit
});

test("loss on sale: proceeds below NBV debit the gain/loss account", () => {
  const r = computeDisposal({ cost: "10000", accumulated: "6000", proceeds: "3000", accounts: acc });
  assert.equal(r.gainLoss, "-1000.0000");
  assert.equal(amt(r, "gl"), "1000.0000"); // loss is a debit
});

test("write-off (no proceeds): the whole NBV is a loss, no proceeds line", () => {
  const r = computeDisposal({ cost: "10000", accumulated: "6000", proceeds: "0", accounts: acc });
  assert.equal(r.gainLoss, "-4000.0000");
  assert.equal(amt(r, "cash"), null);
  assert.equal(amt(r, "gl"), "4000.0000");
});

test("fully-depreciated asset scrapped: no gain/loss line", () => {
  const r = computeDisposal({ cost: "10000", accumulated: "10000", proceeds: "0", accounts: acc });
  assert.equal(r.nbv, "0.0000");
  assert.equal(r.gainLoss, "0.0000");
  assert.deepEqual(r.lines.map((l) => l.accountId).sort(), ["accum", "asset"]);
});

test("proceeds without a proceeds account is rejected", () => {
  assert.throws(
    () => computeDisposal({ cost: "10000", accumulated: "0", proceeds: "5000", accounts: { ...acc, proceedsAccountId: null } }),
    AssetLifecycleError,
  );
});

test("INVARIANT: every disposal entry balances to zero", () => {
  for (const [cost, accum, proceeds] of [
    ["10000", "6000", "5000"], ["10000", "6000", "3000"], ["10000", "6000", "0"],
    ["7500.5000", "1234.5600", "9000"], ["10000", "10000", "250"],
  ] as [string, string, string][]) {
    const r = computeDisposal({ cost, accumulated: accum, proceeds, accounts: acc });
    const total = r.lines.reduce((a, l) => add(a, l.amount), "0");
    assert.ok(isZero(total), `balances for ${cost}/${accum}/${proceeds}, got ${total}`);
  }
});
