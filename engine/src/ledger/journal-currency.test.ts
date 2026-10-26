import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJournalCurrencyLines } from "./journal-currency.ts";
import { parseMoney } from "../money/brands.ts";
import type { SqlExecutor } from "../platform/db.ts";

/** Only the database boundary is replaced; exact conversion uses the native money helpers. */
const runner = {
  execute: async (_query: unknown, mode?: string) =>
    Promise.resolve({ rows: [{ id: "home", currency: "CAD" }] }).then(
      <T extends { rows: unknown }>(result: T) => (mode === "objects" ? result.rows : result),
    ),
} as unknown as SqlExecutor;
const document = {
  id: "journal",
  orgId: "org",
  kind: "journal",
  subsidiaryId: "home",
  accountingBookId: "book",
  currency: "CAD",
  fxRate: "1",
  postingDate: null,
  documentDate: "2026-07-15",
  journalMode: "monetary",
};

test("advanced journal balancing retains original currencies and exact header equivalents", async () => {
  const lines = [
    {
      accountId: "expense",
      subsidiaryId: "home",
      currency: "USD",
      fxRate: "1.35",
      amount: parseMoney("100"),
    },
    { accountId: "payable", currency: "CAD", amount: parseMoney("-135") },
  ];
  const result = await normalizeJournalCurrencyLines(runner, document, lines);
  assert.equal(result[0]?.amount, "100.0000");
  assert.equal(result[0]?.currency, "USD");
  assert.equal(result[0]?.fxRate, "1.35");
  assert.equal(result[0]?.balanceTxnAmount, "135.0000");
  assert.equal(result[1]?.balanceTxnAmount, "-135.0000");
  assert.equal(Object.hasOwn(lines[0]!, "balanceTxnAmount"), false);
});

test("a foreign header uses its stated rate to compare a functional-currency line", async () => {
  const result = await normalizeJournalCurrencyLines(
    runner,
    { ...document, currency: "USD", fxRate: "1.25" },
    [
      { accountId: "expense", currency: "CAD", fxRate: "1", amount: parseMoney("125") },
      { accountId: "payable", currency: "USD", amount: parseMoney("-100") },
    ],
  );
  assert.equal(result[0]?.balanceTxnAmount, "100.0000");
  assert.equal(result[1]?.balanceTxnAmount, "-100.0000");
});

test("statistical and typed currency-adjustment lines do not acquire monetary translations", async () => {
  const lines = [
    { accountId: "statistic", amount: parseMoney("0"), quantity: "12.0001", unit: "FTE" },
  ];
  assert.equal(
    await normalizeJournalCurrencyLines(runner, { ...document, journalMode: "statistical" }, lines),
    lines,
  );
  const residual = [
    {
      accountId: "bank",
      amount: parseMoney("1"),
      currency: "USD",
      txnAmount: "0",
      isCurrencyAdjustment: true,
    },
  ];
  assert.equal(
    await normalizeJournalCurrencyLines(
      runner,
      { ...document, journalMode: "currency_adjustment" },
      residual,
    ),
    residual,
  );
});

test("a monetary journal without a header entity refuses before querying currency scopes", async () => {
  const noQueries = {
    execute: async () => {
      assert.fail("a missing accounting entity must refuse before database queries");
    },
  } as unknown as SqlExecutor;
  await assert.rejects(
    normalizeJournalCurrencyLines(noQueries, { ...document, subsidiaryId: null }, [
      { accountId: "expense", amount: parseMoney("10") },
    ]),
    /no accounting entity/,
  );
});
