import assert from "node:assert/strict";
import test from "node:test";
import { verifyAccountMonths } from "./verification.ts";

test("account-month verification uses identical exact aggregation for every connector", () => {
  const result = verifyAccountMonths(
    [
      { accountRef: "1000", month: "2026-01", amount: "10.0000" },
      { accountRef: "1000", month: "2026-01", amount: "-2.0000" },
      { accountRef: "2000", month: "2026-02", amount: "5.0000" },
      { accountRef: "3000", month: "2026-03", amount: "0" },
    ],
    [
      { accountRef: "1000", month: "2026-01", amount: "8" },
      { accountRef: "2000", month: "2026-02", amount: "4" },
      { accountRef: "4000", month: "2026-04", amount: "1" },
    ],
  );

  assert.deepEqual(result, {
    checked: 4,
    matches: 2,
    mismatches: [
      { accountRef: "2000", month: "2026-02", ours: "4.0000", theirs: "5.0000" },
      { accountRef: "4000", month: "2026-04", ours: "1.0000", theirs: "0.0000" },
    ],
  });
});

test("account-month verification rejects malformed source buckets", () => {
  assert.throws(
    () => verifyAccountMonths([{ accountRef: "1000", month: "2026-13", amount: "1" }], []),
    /invalid month/,
  );
  assert.throws(
    () => verifyAccountMonths([{ accountRef: "", month: "2026-01", amount: "1" }], []),
    /no account reference/,
  );
  assert.throws(
    () => verifyAccountMonths([{ accountRef: "1000", month: "2026-01", amount: "not-money" }], []),
    /invalid amount/,
  );
});

test("account-month verification caps diagnostics without hiding the failed count", () => {
  const result = verifyAccountMonths(
    [
      { accountRef: "1000", month: "2026-01", amount: "1" },
      { accountRef: "2000", month: "2026-01", amount: "2" },
    ],
    [],
    1,
  );

  assert.equal(result.checked, 2);
  assert.equal(result.matches, 0);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.checked - result.matches, 2);
});
