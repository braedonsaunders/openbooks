import assert from "node:assert/strict";
import test from "node:test";
import { AssetLifecycleError, computeDisposal, computeRemeasurement, disposeAsset, remeasureAsset, type DisposalAccounts } from "./asset-lifecycle.ts";
import { add, isZero } from "../money/money.ts";

const acc: DisposalAccounts = {
  assetAccountId: "asset",
  accumulatedDepreciationAccountId: "accum",
  gainLossAccountId: "gl",
  proceedsAccountId: "cash",
};
const amt = (r: { lines: { accountId: string; amount: string }[] }, id: string) =>
  r.lines.find((l) => l.accountId === id)?.amount ?? null;

/* Disposal lock-then-read ordering is proven under real concurrency in
 * asset-lifecycle.integration.test.ts ("concurrent disposals serialize on
 * the asset row: exactly one writes"): the loser must observe the winner's
 * committed status instead of computing from a pre-lock snapshot. */

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

const rm = { accumulatedDepreciationAccountId: "accum", adjustmentAccountId: "gl" };

test("impairment write-down debits the loss and credits accumulated depreciation", () => {
  // cost 10000, accum 4000 → NBV 6000; impaired to 5000 → delta −1000.
  const r = computeRemeasurement({ cost: "10000", accumulated: "4000", newCarryingValue: "5000", ...rm });
  assert.equal(r.delta, "-1000.0000");
  assert.equal(r.lines.find((l) => l.accountId === "gl")!.amount, "1000.0000"); // loss (debit)
  assert.equal(r.lines.find((l) => l.accountId === "accum")!.amount, "-1000.0000"); // increase accum (credit)
});

test("revaluation write-up debits accumulated and credits the reserve", () => {
  const r = computeRemeasurement({ cost: "10000", accumulated: "4000", newCarryingValue: "7000", ...rm });
  assert.equal(r.delta, "1000.0000");
  assert.equal(r.lines.find((l) => l.accountId === "accum")!.amount, "1000.0000"); // reduce accum (debit)
  assert.equal(r.lines.find((l) => l.accountId === "gl")!.amount, "-1000.0000"); // reserve (credit)
});

test("no remeasurement when the value is unchanged", () => {
  const r = computeRemeasurement({ cost: "10000", accumulated: "4000", newCarryingValue: "6000", ...rm });
  assert.equal(r.delta, "0.0000");
  assert.deepEqual(r.lines, []);
});

test("INVARIANT: every remeasurement entry balances to zero", () => {
  for (const [accum, newCv] of [["4000", "5000"], ["4000", "7000"], ["0", "250.5000"]] as [string, string][]) {
    const r = computeRemeasurement({ cost: "10000", accumulated: accum, newCarryingValue: newCv, ...rm });
    assert.ok(isZero(r.lines.reduce((a, l) => add(a, l.amount), "0")));
  }
});

test("a write-off with proceeds is rejected before anything posts (proceeds would be silently dropped)", () => {
  // Validation sits ahead of the transaction, so no database is touched: with
  // no OPENBOOKS_DB_URL any reach-through to the database would throw a
  // non-lifecycle error and fail this validator instead.
  return assert.rejects(
    disposeAsset("org", "asset", {
      writeOff: true,
      proceeds: "500",
      proceedsAccountId: "cash",
      date: "2026-07-31",
      actorId: "actor",
    }),
    (e) => e instanceof AssetLifecycleError && /write-off takes no proceeds/.test(e.message),
  );
});

test("a disposal with negative proceeds is rejected (sale proceeds are never negative)", () => {
  return assert.rejects(
    disposeAsset("org", "asset", {
      proceeds: "-100",
      proceedsAccountId: "cash",
      date: "2026-07-31",
      actorId: "actor",
    }),
    (e) => e instanceof AssetLifecycleError && /non-negative/.test(e.message),
  );
});

test("a remeasurement to a negative carrying value is rejected (recoverable amounts cannot be negative)", () => {
  return assert.rejects(
    remeasureAsset("org", "asset", {
      newCarryingValue: "-100",
      date: "2026-07-31",
      actorId: "actor",
    }),
    (e) => e instanceof AssetLifecycleError && /non-negative/.test(e.message),
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
