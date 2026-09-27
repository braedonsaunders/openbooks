/**
 * Balancing-leg provider registry: the contract the fund segment builds on.
 * Keyed registration is idempotent (the composition root runs once per
 * process and again per test), providers only append, a later provider sees
 * earlier legs, and a refusal propagates with its remedy intact.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Money } from "../money/brands.ts";
import type { SqlExecutor } from "../platform/db.ts";
import {
  clearBalancingLegProviders,
  collectBalancingLegs,
  registerBalancingLegProvider,
  type BalancingLeg,
} from "./balancing-hooks.ts";

const runner = {} as SqlExecutor;
const ctx = {
  orgId: "org-1",
  postingDate: "2026-09-30",
  bookId: null,
  sourceDocumentId: null,
  regeneration: false,
};
const lines = [
  { accountId: "bank", amount: "100.0000", subsidiaryId: "sub-1", currency: "USD", txnAmount: "100.0000", fxRate: "1", extraDims: { fund: "general" } },
  { accountId: "revenue", amount: "-100.0000", subsidiaryId: "sub-1", currency: "USD", txnAmount: "-100.0000", fxRate: "1", extraDims: { fund: "scholarships" } },
];

function leg(accountId: string, amount: string, fund: string): BalancingLeg {
  return {
    accountId,
    amount: amount as Money,
    subsidiaryId: "sub-1",
    currency: "USD",
    txnAmount: amount as Money,
    fxRate: "1",
    extraDims: { fund },
    memo: `due ${fund}`,
  };
}

test("no providers: no legs, the kernel line set is untouched", async () => {
  clearBalancingLegProviders();
  assert.deepEqual(await collectBalancingLegs(runner, ctx, lines), []);
});

test("keyed registration replaces instead of running twice; later providers see earlier legs", async () => {
  clearBalancingLegProviders();
  let runs = 0;
  const fund = async () => {
    runs += 1;
    return [leg("due-to-scholarships", "-100.0000", "general"), leg("due-from-general", "100.0000", "scholarships")];
  };
  registerBalancingLegProvider("fund", fund);
  registerBalancingLegProvider("fund", fund);
  let seen = 0;
  registerBalancingLegProvider("grant", async (_runner, _ctx, view) => {
    seen = view.length;
    return [];
  });
  const legs = await collectBalancingLegs(runner, ctx, lines);
  assert.equal(runs, 1);
  assert.deepEqual(legs.map((l) => [l.accountId, l.amount, l.extraDims.fund]), [
    ["due-to-scholarships", "-100.0000", "general"],
    ["due-from-general", "100.0000", "scholarships"],
  ]);
  assert.equal(seen, 4, "the second provider sees the two lines plus the first provider's two legs");
  clearBalancingLegProviders();
});

test("a provider refusal propagates with its remedy intact", async () => {
  clearBalancingLegProviders();
  registerBalancingLegProvider("fund", async () => {
    throw new Error("no interfund pair between GENERAL and SCHOLAR; add one under Setup → Nonprofit → Interfund pairs");
  });
  await assert.rejects(collectBalancingLegs(runner, ctx, lines), /add one under Setup/);
  clearBalancingLegProviders();
});
