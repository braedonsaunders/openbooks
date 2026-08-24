import assert from "node:assert/strict";
import test from "node:test";
import { filterDuplicateStatementLines, type ParsedStatementLine } from "./banking.ts";
import { plaidFetchAllTransactions } from "./bank-feed-providers.ts";

const line = (overrides: Partial<ParsedStatementLine> = {}): ParsedStatementLine => ({
  postedOn: "2026-08-01",
  amount: "-25.0000",
  description: "COFFEE SHOP",
  counterpartyRef: null,
  bankTransactionId: null,
  ...overrides,
});

test("content-identical ID-less transactions in separate imports both remain fresh", () => {
  const first = filterDuplicateStatementLines([line()], new Set());
  assert.equal(first.lines.length, 1);
  assert.equal(first.lines[0].bankTransactionId, null);

  // The first import persisted no source ID, so there is no sound identity to
  // suppress a second real transaction with the same visible content.
  const persistedSourceIds = new Set(
    first.lines.flatMap((entry) =>
      entry.bankTransactionId ? [entry.bankTransactionId] : [],
    ),
  );
  const second = filterDuplicateStatementLines([line()], persistedSourceIds);
  assert.equal(second.lines.length, 1);
  assert.equal(second.duplicates, 0);
});

test("content-identical ID-less transactions within one import are all retained", () => {
  const filtered = filterDuplicateStatementLines([line(), line(), line()], new Set());
  assert.equal(filtered.lines.length, 3);
  assert.equal(filtered.duplicates, 0);
});

test("source-provided transaction IDs still dedupe across and within imports", () => {
  const filtered = filterDuplicateStatementLines(
    [
      line({ bankTransactionId: "FITID-existing" }),
      line({ bankTransactionId: "FITID-new" }),
      line({ bankTransactionId: "FITID-new" }),
      line(),
    ],
    new Set(["FITID-existing"]),
  );
  assert.deepEqual(
    filtered.lines.map((entry) => entry.bankTransactionId),
    ["FITID-new", null],
  );
  assert.equal(filtered.duplicates, 2);
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
