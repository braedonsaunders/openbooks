import assert from "node:assert/strict";
import test from "node:test";
import {
  agingBucketCount,
  agingBucketIndex,
  agingBucketPolicyFor,
  AgingBucketPolicyUnreadableError,
  DEFAULT_AGING_BOUNDARIES,
} from "./aging-buckets.ts";

// The default ladder is the product's historical buckets, stated once: an
// item due today is current, 1–30 days past due is bucket 1, 31–60 bucket 2,
// 61–89 bucket 3, and 90+ the final bucket. Every consumer must agree with
// the legacy web/lib/aging-basis.ts split at each of these edges.
test("default ladder reproduces the historical 30/60/90 buckets", () => {
  assert.deepEqual([...DEFAULT_AGING_BOUNDARIES], [30, 60, 90]);
  assert.equal(agingBucketCount(DEFAULT_AGING_BOUNDARIES), 5);
  const cases: Array<[number, number]> = [
    [-400, 0],
    [0, 0],
    [1, 1],
    [30, 1],
    [31, 2],
    [60, 2],
    [61, 3],
    [89, 3],
    [90, 4],
    [4000, 4],
  ];
  for (const [days, bucket] of cases) {
    assert.equal(agingBucketIndex(days, DEFAULT_AGING_BOUNDARIES), bucket, `${days} days past due`);
  }
});

test("a configured ladder re-derives every edge from its own boundaries", () => {
  // Like the default ladder, the final boundary opens the last bucket: under
  // [7, 14] the buckets are current / 1–7 / 8–13 / 14+.
  const boundaries = [7, 14] as const;
  assert.equal(agingBucketCount(boundaries), 4);
  const cases: Array<[number, number]> = [
    [0, 0],
    [7, 1],
    [8, 2],
    [13, 2],
    [14, 3],
    [15, 3],
  ];
  for (const [days, bucket] of cases) {
    assert.equal(agingBucketIndex(days, boundaries), bucket, `${days} days past due`);
  }
});

test("a non-finite age refuses instead of landing in a bucket", () => {
  assert.throws(() => agingBucketIndex(Number.NaN, DEFAULT_AGING_BOUNDARIES), RangeError);
  assert.throws(() => agingBucketIndex(Number.POSITIVE_INFINITY, DEFAULT_AGING_BOUNDARIES), RangeError);
});

// The executor is the database port, stubbed here so the read contract is
// covered with no database: a configured row resolves its ladder, and a row
// that cannot be read refuses by name instead of silently defaulting.
test("a configured row resolves; an unreadable row refuses by name", async () => {
  const valid = await agingBucketPolicyFor("org-valid", "2026-07-01", {
    execute: async () => ({ rows: [{ boundaries: [7, 14], effective_from: "2026-01-01" }] }),
  } as never);
  assert.equal(valid.source, "policy");
  assert.deepEqual([...valid.boundaries], [7, 14]);

  // A ladder the write path could never have stored — non-numeric, flat,
  // descending, or out of range — is corrupt storage, not a policy: it
  // refuses rather than re-bucketing history under a ladder nobody entered.
  const corrupt: unknown[] = [["thirty"], [30, 30], [60, 30], [0], [36501]];
  for (const boundaries of corrupt) {
    await assert.rejects(
      agingBucketPolicyFor("org-broken", "2026-07-01", {
        execute: async () => ({ rows: [{ boundaries, effective_from: "2026-01-01" }] }),
      } as never),
      (error: unknown) => {
        assert.ok(error instanceof AgingBucketPolicyUnreadableError);
        assert.match(error.message, /Setup → Company → Aging bucket policies/);
        return true;
      },
      `boundaries ${JSON.stringify(boundaries)} refuse`,
    );
  }
});
