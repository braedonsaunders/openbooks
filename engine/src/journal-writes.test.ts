// Run with:  node --import tsx --test engine/src/journal-writes.test.ts   (from repo root)
//
// Unit tests for the PURE validation half of governed journal writes — the
// gate every sandbox-originated ledger write passes before touching the DB.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJournalInput, JournalWriteError } from "./journal-writes.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("a balanced two-line journal validates and normalizes", () => {
  const v = validateJournalInput({
    documentDate: "2026-07-16",
    memo: "accrual",
    lines: [
      { accountId: A, amount: 100.5, description: "debit side" },
      { accountId: B, amount: -100.5 },
    ],
  });
  assert.equal(v.documentDate, "2026-07-16");
  assert.equal(v.totalDebits, "100.5000");
  assert.equal(v.lines[0]!.amount, "100.5000");
  assert.equal(v.lines[1]!.amount, "-100.5000");
});

test("account codes are accepted in place of ids", () => {
  const v = validateJournalInput({
    documentDate: "2026-07-16",
    lines: [
      { accountCode: "5100", amount: 10 },
      { accountCode: "2100", amount: -10 },
    ],
  });
  assert.equal(v.lines[0]!.accountCode, "5100");
});

test("an unbalanced journal is refused", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: A, amount: 100 }, { accountId: B, amount: -99.99 }] }),
    (e: Error) => e instanceof JournalWriteError && /not balanced/.test(e.message),
  );
});

test("fewer than 2 lines is refused", () => {
  assert.throws(() => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: A, amount: 0 }] }), /at least 2 lines/);
});

test("zero and non-numeric amounts are refused", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: A, amount: 0 }, { accountId: B, amount: 0 }] }),
    /nonzero number/,
  );
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: A, amount: "abc" }, { accountId: B, amount: -1 }] }),
    /nonzero number/,
  );
});

test("a line without any account reference is refused", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ amount: 5 }, { accountId: B, amount: -5 }] }),
    /accountId or accountCode required/,
  );
});

test("a malformed accountId is refused", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "2026-07-16", lines: [{ accountId: "nope", amount: 5 }, { accountId: B, amount: -5 }] }),
    /invalid accountId/,
  );
});

test("bad dates are refused; a missing date is refused rather than defaulted to UTC today", () => {
  assert.throws(
    () => validateJournalInput({ documentDate: "07/16/2026", lines: [{ accountId: A, amount: 1 }, { accountId: B, amount: -1 }] }),
    /invalid documentDate/,
  );
  assert.throws(
    () => validateJournalInput({ lines: [{ accountId: A, amount: 1 }, { accountId: B, amount: -1 }] }),
    /documentDate is required/,
  );
});

test("4dp rounding keeps a float-noise journal balanced", () => {
  // 0.1 + 0.2 - 0.3 = 5.55e-17 in floats; must still count as balanced.
  const v = validateJournalInput({
    documentDate: "2026-07-16",
    lines: [
      { accountId: A, amount: 0.1 },
      { accountId: A, amount: 0.2 },
      { accountId: B, amount: -0.3 },
    ],
  });
  assert.equal(v.totalDebits, "0.3000");
});

test("journal-line persist writes amount through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./journal-writes.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistJournalLineAmount");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistJournalLineAmount helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /JournalWriteError/);

  const start = source.indexOf("export function validateJournalInput");
  const next = source.indexOf("async function controlDeps");
  const body = source.slice(start, next);
  assert.match(body, /persistJournalLineAmount\(l\.amount, i \+ 1\)/);
  assert.doesNotMatch(body, /normalizeMoney\(l\.amount\)/);
});

test("line cap is enforced", () => {
  const lines = Array.from({ length: 201 }, (_, i) => ({ accountId: A, amount: i % 2 === 0 ? 1 : -1 }));
  assert.throws(() => validateJournalInput({ documentDate: "2026-07-16", lines }), /too many lines/);
});
