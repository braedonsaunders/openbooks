import assert from "node:assert/strict";
import test from "node:test";
import {
  differenceRetroEarnings,
  payableRetroBuckets,
  retroBucketKey,
  retroOutcome,
  RetroPayError,
  summarizeRetro,
  type RetroEarningLine,
} from "./payroll-retro.ts";

/**
 * The retro difference, tested as pure arithmetic — no database, no clock, no
 * configuration. Every claim below is reproducible from its arguments.
 *
 * These are the properties the money rests on:
 *
 *  1. the bucket deltas always sum to the period delta, exactly;
 *  2. paying a difference makes the SAME difference zero next time, and a
 *     later correction is still payable — the "exactly once" property, which
 *     a settled flag gets half right and this gets whole;
 *  3. a backdated decrease is reported and refused, never netted;
 *  4. an untagged bucket is one bucket.
 */

const line = (over: Partial<RetroEarningLine> = {}): RetroEarningLine => ({
  componentId: "base",
  description: "Regular",
  projectId: null,
  departmentId: null,
  amount: "0",
  hours: null,
  ...over,
});

test("a rate increase differences to the per-bucket difference, exactly", () => {
  const difference = differenceRetroEarnings({
    original: [
      line({ projectId: "jobA", amount: "1800.00", hours: "60" }),
      line({ projectId: "jobB", amount: "600.00", hours: "20" }),
    ],
    recomputed: [
      line({ projectId: "jobA", amount: "1980.00", hours: "60" }),
      line({ projectId: "jobB", amount: "660.00", hours: "20" }),
    ],
  });
  assert.equal(difference.originalEarnings, "2400.0000");
  assert.equal(difference.recomputedEarnings, "2640.0000");
  assert.equal(difference.delta, "240.0000");
  assert.deepEqual(
    difference.buckets.map((b) => [b.projectId, b.amount]),
    [["jobA", "180.0000"], ["jobB", "60.0000"]],
  );
  // The proportions the ORIGINAL hours had: 60/80 and 20/80 of the increase.
  assert.equal(difference.buckets[0]!.originalHours, "60.0000");
});

test("paying a difference makes it zero next time, and a later correction is still payable", () => {
  const original = [line({ amount: "1000.00" })];
  const afterFirstIncrease = [line({ amount: "1100.00" })];

  const first = differenceRetroEarnings({ original, recomputed: afterFirstIncrease });
  assert.equal(first.delta, "100.0000");

  // The retro run commits: what it settled becomes the high-water mark.
  const settled = first.buckets.map((bucket) => ({
    componentId: bucket.componentId,
    projectId: bucket.projectId,
    departmentId: bucket.departmentId,
    previouslySettled: bucket.amount,
  }));

  // Detection runs again against exactly the same configuration.
  const second = differenceRetroEarnings({
    original, recomputed: afterFirstIncrease, settled,
  });
  assert.equal(second.delta, "0.0000", "the same money is never owed twice");
  assert.equal(retroOutcome(second.delta), "none");

  // The settlement is then CORRECTED upward. Only the increment is owed — a
  // "already settled" flag would refuse this entirely.
  const third = differenceRetroEarnings({
    original, recomputed: [line({ amount: "1150.00" })], settled,
  });
  assert.equal(third.delta, "50.0000");
  assert.equal(retroOutcome(third.delta), "payable");
});

test("a bucket that has vanished from both sides still carries what was settled", () => {
  // The retro paid $40 against a job that has since been removed from the
  // stub entirely. Dropping the bucket would make the period look owed again.
  const difference = differenceRetroEarnings({
    original: [line({ projectId: "jobA", amount: "500.00" })],
    recomputed: [line({ projectId: "jobA", amount: "500.00" })],
    settled: [
      { componentId: "base", projectId: "gone", departmentId: null, previouslySettled: "40.00" },
    ],
  });
  assert.equal(difference.previouslySettled, "40.0000");
  assert.equal(difference.delta, "-40.0000");
  assert.equal(retroOutcome(difference.delta), "overpaid");
  assert.equal(
    difference.buckets.reduce((total, b) => total + Number(b.amount), 0),
    -40,
    "bucket deltas still sum to the period delta",
  );
});

test("a backdated decrease is reported, never paid", () => {
  const difference = differenceRetroEarnings({
    original: [line({ amount: "2400.00" })],
    recomputed: [line({ amount: "2200.00" })],
  });
  assert.equal(difference.delta, "-200.0000");
  assert.equal(retroOutcome(difference.delta), "overpaid");
  assert.throws(() => payableRetroBuckets(difference), RetroPayError);
});

test("one job falling while another rises keeps both signs and the right total", () => {
  const difference = differenceRetroEarnings({
    original: [
      line({ projectId: "jobA", amount: "1000.00" }),
      line({ projectId: "jobB", amount: "1000.00" }),
    ],
    recomputed: [
      line({ projectId: "jobA", amount: "1400.00" }),
      line({ projectId: "jobB", amount: "900.00" }),
    ],
  });
  assert.equal(difference.delta, "300.0000");
  const paying = payableRetroBuckets(difference);
  assert.deepEqual(
    paying.map((b) => [b.projectId, b.amount]),
    [["jobA", "400.0000"], ["jobB", "-100.0000"]],
    "job B was over-costed and the retro takes it back off that job",
  );
});

test("an untagged bucket is ONE bucket", () => {
  assert.equal(
    retroBucketKey({ componentId: "base", projectId: null, departmentId: null }),
    retroBucketKey({ componentId: "base", projectId: null, departmentId: null }),
  );
  const difference = differenceRetroEarnings({
    original: [line({ amount: "100.00" }), line({ amount: "100.00" })],
    recomputed: [line({ amount: "250.00" })],
  });
  assert.equal(difference.buckets.length, 1);
  assert.equal(difference.delta, "50.0000");
});

test("a new component that did not exist in the source period is entirely retro", () => {
  const difference = differenceRetroEarnings({
    original: [line({ amount: "1000.00" })],
    recomputed: [
      line({ amount: "1000.00" }),
      line({ componentId: "premium", description: "Shift premium", amount: "75.00" }),
    ],
  });
  assert.equal(difference.delta, "75.0000");
  const paying = payableRetroBuckets(difference);
  assert.equal(paying.length, 1, "the unchanged bucket is not a line for nothing");
  assert.equal(paying[0]!.description, "Shift premium");
});

test("payable and overpaid are summarized apart, never netted", () => {
  const summary = summarizeRetro([
    { employeePartyId: "e1", employeeName: "Avery", delta: "180.00" },
    { employeePartyId: "e1", employeeName: "Avery", delta: "-40.00" },
    { employeePartyId: "e1", employeeName: "Avery", delta: "0.00" },
    { employeePartyId: "e2", employeeName: "Blair", delta: "12.50" },
  ]);
  assert.deepEqual(summary, [
    { employeePartyId: "e1", employeeName: "Avery", periods: 3, payable: "180.0000", overpaid: "-40.0000" },
    { employeePartyId: "e2", employeeName: "Blair", periods: 1, payable: "12.5000", overpaid: "0.0000" },
  ]);
});

test("fractional-cent inputs are refused rather than silently rounded into money", () => {
  // money.ts is the only arithmetic in this module, and it does not tolerate
  // precision it cannot represent. A rate that produced a sub-cent line would
  // be a bug upstream, and it must not be laundered here.
  assert.throws(() => differenceRetroEarnings({
    original: [line({ amount: "1.000001" })],
    recomputed: [line({ amount: "2.00" })],
  }), /precision/);
});
