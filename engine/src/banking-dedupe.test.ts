import assert from "node:assert/strict";
import test from "node:test";
import { synthesizeTransactionIds, type ParsedStatementLine } from "./banking.ts";
import { plaidFetchAllTransactions } from "./bank-feed-providers.ts";

const line = (overrides: Partial<ParsedStatementLine> = {}): ParsedStatementLine => ({
  postedOn: "2026-08-01",
  amount: "-25.0000",
  description: "COFFEE SHOP",
  counterpartyRef: null,
  bankTransactionId: null,
  ...overrides,
});

test("identical tuples in two different import batches get distinct fallback keys", () => {
  // Two genuinely different same-day/same-amount transactions imported in two
  // separate files must never share a key — the second must not be silently
  // dropped as a duplicate of the first.
  const lines = [line()];
  const first = synthesizeTransactionIds("acc-1", lines, "token-file-a");
  const second = synthesizeTransactionIds("acc-1", lines, "token-file-b");
  assert.notEqual(first[0].bankTransactionId, second[0].bankTransactionId);
});

test("the same batch token reproduces the same keys, so re-importing a file is a no-op", () => {
  const lines = [
    line(),
    line({ postedOn: "2026-08-02", amount: "100.0000", description: "DEPOSIT" }),
    line({ postedOn: "2026-08-03", amount: "-9.9900", description: null }),
  ];
  const first = synthesizeTransactionIds("acc-1", lines, "token-file-a");
  const reimport = synthesizeTransactionIds("acc-1", lines, "token-file-a");
  assert.deepEqual(
    reimport.map((l) => l.bankTransactionId),
    first.map((l) => l.bankTransactionId),
  );
});

test("occurrence index still disambiguates identical tuples within one batch", () => {
  const lines = [line(), line(), line()];
  const keyed = synthesizeTransactionIds("acc-1", lines, "token-file-a");
  const ids = new Set(keyed.map((l) => l.bankTransactionId));
  assert.equal(ids.size, 3);
});

test("source-provided transaction ids pass through untouched", () => {
  const keyed = synthesizeTransactionIds(
    "acc-1",
    [line({ bankTransactionId: "FITID-42" })],
    "token-file-a",
  );
  assert.equal(keyed[0].bankTransactionId, "FITID-42");
});

test("plaid pagination accumulates every page until has_more is false", async () => {
  const pages = [
    { transactions: [{ transaction_id: "t1" }, { transaction_id: "t2" }], has_more: true },
    { transactions: [{ transaction_id: "t3" }], has_more: true },
    { transactions: [], has_more: false },
  ];
  const offsetsSeen: number[] = [];
  const all = await plaidFetchAllTransactions(async (offset) => {
    offsetsSeen.push(offset);
    return pages[offsetsSeen.length - 1];
  });
  assert.deepEqual(offsetsSeen, [0, 500, 1000]);
  assert.deepEqual(all, pages.flatMap((p) => p.transactions));
});

test("plaid pagination aborts loudly past the hard page cap instead of truncating", async () => {
  let calls = 0;
  await assert.rejects(
    plaidFetchAllTransactions(async () => {
      calls += 1;
      return { transactions: [{ transaction_id: `t${calls}` }], has_more: true };
    }),
    /exceeded 20 pages/,
  );
  assert.equal(calls, 20);
});
