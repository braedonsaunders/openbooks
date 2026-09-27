import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../money/money.ts";
import { interfundLegs, type FundPostingLine, type FundPairView } from "./fund-posting.ts";

const operating = "10000000-0000-4000-8000-000000000001";
const restricted = "20000000-0000-4000-8000-000000000002";
const dueFrom = "30000000-0000-4000-8000-000000000003";
const dueTo = "40000000-0000-4000-8000-000000000004";
const root = "50000000-0000-4000-8000-000000000005";
const branch = "60000000-0000-4000-8000-000000000006";

const fundCodes = new Map([
  [operating, "OPERATING"],
  [restricted, "SCHOLARSHIP"],
]);

function line(subsidiaryId: string, fundId: string, amount: string): FundPostingLine {
  return {
    accountId: amount.startsWith("-") ? "revenue" : "cash",
    amount,
    subsidiaryId,
    currency: "CAD",
    txnAmount: amount,
    fxRate: "1",
    fundId,
  };
}

function assertCellsBalance(lines: readonly FundPostingLine[]) {
  const totals = new Map<string, bigint>();
  for (const entry of lines) {
    const key = `${entry.subsidiaryId}:${entry.fundId}`;
    totals.set(key, (totals.get(key) ?? 0n) + toUnits(entry.amount));
  }
  for (const [key, total] of totals) assert.equal(total, 0n, `${key} balances`);
}

test("interfund legs balance two distinct funds", () => {
  const lines = [line(root, operating, "125.0000"), line(root, restricted, "-125.0000")];
  const pairs: FundPairView[] = [{
    fromFundId: restricted,
    toFundId: operating,
    dueFromAccountId: dueFrom,
    dueToAccountId: dueTo,
  }];
  const legs = interfundLegs(lines, pairs, fundCodes, new Map([[root, "CAD"]]));
  assert.equal(legs.length, 2);
  assert.deepEqual(legs.map((leg) => leg.accountId), [dueFrom, dueTo]);
  assert.deepEqual(legs.map((leg) => leg.currency), ["CAD", "CAD"]);
  assert.deepEqual(legs.map((leg) => leg.fxRate), ["1", "1"]);
  assertCellsBalance([...lines, ...legs.map((leg) => ({ ...leg, fundId: leg.extraDims.fund! }))]);
});

test("interfund legs balance two funds in two subsidiaries", () => {
  const lines = [
    line(root, operating, "125.0000"),
    line(root, restricted, "-125.0000"),
    line(branch, operating, "-80.0000"),
    line(branch, restricted, "80.0000"),
  ];
  const pairs: FundPairView[] = [
    { fromFundId: restricted, toFundId: operating, dueFromAccountId: dueFrom, dueToAccountId: dueTo },
    { fromFundId: operating, toFundId: restricted, dueFromAccountId: dueTo, dueToAccountId: dueFrom },
  ];
  const legs = interfundLegs(
    lines,
    pairs,
    fundCodes,
    new Map([[root, "CAD"], [branch, "USD"]]),
    new Map([[root, "Main Office"], [branch, "Northern Office"]]),
  );
  assert.equal(legs.length, 4);
  assertCellsBalance([...lines, ...legs.map((leg) => ({ ...leg, fundId: leg.extraDims.fund! }))]);
  assert.deepEqual(new Set(legs.map((leg) => leg.currency)), new Set(["CAD", "USD"]));
});
