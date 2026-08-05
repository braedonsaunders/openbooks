import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyAccountMonths,
  verifyProjectAccountMonths,
} from "./verification.ts";

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

test("account verification preserves exact source posting-period identity", () => {
  assert.deepEqual(
    verifyAccountMonths(
      [
        {
          accountRef: "4000",
          periodRef: "ordinary-12",
          month: "2026-12",
          amount: "-10",
        },
        {
          accountRef: "4000",
          periodRef: "adjustment-13",
          month: "2026-12",
          amount: "-2",
        },
      ],
      [
        {
          accountRef: "4000",
          periodRef: "ordinary-12",
          month: "2026-12",
          amount: "-12",
        },
      ],
    ),
    {
      checked: 2,
      matches: 0,
      mismatches: [
        {
          accountRef: "4000",
          periodRef: "adjustment-13",
          month: "2026-12",
          ours: "0.0000",
          theirs: "-2.0000",
        },
        {
          accountRef: "4000",
          periodRef: "ordinary-12",
          month: "2026-12",
          ours: "-12.0000",
          theirs: "-10.0000",
        },
      ],
    },
  );
});

test("period-exact verification rejects a target row without period identity", () => {
  assert.throws(
    () =>
      verifyAccountMonths(
        [
          {
            accountRef: "4000",
            periodRef: "17",
            month: "2026-07",
            amount: "1",
          },
        ],
        [{ accountRef: "4000", month: "2026-07", amount: "1" }],
      ),
    /no exact period reference/,
  );
});

test("project-account-month verification is exact and bidirectional", () => {
  const result = verifyProjectAccountMonths(
    [
      { projectRef: "job-1", accountRef: "4000", month: "2026-01", amount: "-8" },
      { projectRef: "job-1", accountRef: "4000", month: "2026-01", amount: "-2" },
      { projectRef: "job-2", accountRef: "5000", month: "2026-02", amount: "5" },
    ],
    [
      { projectRef: "job-1", accountRef: "4000", month: "2026-01", amount: "-10" },
      { projectRef: "job-3", accountRef: "5000", month: "2026-03", amount: "1" },
    ],
  );

  assert.deepEqual(result, {
    checked: 3,
    matches: 1,
    mismatches: [
      {
        projectRef: "job-2",
        accountRef: "5000",
        month: "2026-02",
        ours: "0.0000",
        theirs: "5.0000",
      },
      {
        projectRef: "job-3",
        accountRef: "5000",
        month: "2026-03",
        ours: "1.0000",
        theirs: "0.0000",
      },
    ],
  });
});

test("project-account-month verification rejects missing dimensions", () => {
  assert.throws(
    () =>
      verifyProjectAccountMonths(
        [{ projectRef: "", accountRef: "4000", month: "2026-01", amount: "1" }],
        [],
      ),
    /no project reference/,
  );
  assert.throws(
    () =>
      verifyProjectAccountMonths(
        [{ projectRef: "job", accountRef: "", month: "2026-01", amount: "1" }],
        [],
      ),
    /no account reference/,
  );
});
