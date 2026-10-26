import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateCertifiedPayAmounts,
  type CertifiedPaidTimeBucket,
} from "./construction/certified.ts";
import { HrmConstructionError } from "./construction/errors.ts";

const buckets: CertifiedPaidTimeBucket[] = [
  { workedOn: "2026-09-08", projectId: "project-a", hours: "4.0000" },
  { workedOn: "2026-09-09", projectId: "project-a", hours: "4.0000" },
  { workedOn: "2026-09-10", projectId: null, hours: "2.0000" },
];

test("certified payroll allocates each run total once in proportion to paid hours", () => {
  const allocated = allocateCertifiedPayAmounts(buckets, {
    deductions: "25.0000",
    net: "100.0000",
  });
  assert.deepEqual(
    allocated.map(({ deductions, net }) => [deductions, net]),
    [
      ["10.0000", "40.0000"],
      ["10.0000", "40.0000"],
      ["5.0000", "20.0000"],
    ],
  );
  assert.equal(
    allocated.reduce((total, bucket) => total + BigInt(bucket.net.replace(".", "")), 0n),
    1_000_000n,
  );
  assert.equal(
    allocated.reduce((total, bucket) => total + BigInt(bucket.deductions.replace(".", "")), 0n),
    250_000n,
  );
});

test("certified payroll assigns sub-cent rounding remainder deterministically", () => {
  const allocated = allocateCertifiedPayAmounts(
    buckets.map((bucket) => ({ ...bucket, hours: "1.0000" })),
    {
      deductions: "0.0001",
      net: "0.0002",
    },
  );
  assert.deepEqual(
    allocated.map(({ deductions, net }) => [deductions, net]),
    [
      ["0.0001", "0.0002"],
      ["0.0000", "0.0000"],
      ["0.0000", "0.0000"],
    ],
  );
});

test("certified payroll refuses to allocate amounts without positive paid hours", () => {
  assert.throws(
    () =>
      allocateCertifiedPayAmounts([{ ...buckets[0]!, hours: "0.0000" }], {
        deductions: "25.0000",
        net: "100.0000",
      }),
    (error: unknown) =>
      error instanceof HrmConstructionError && /positive hours/.test(error.message),
  );
});

test("certified payroll cannot discard a nonzero stub when no paid time exists", () => {
  assert.throws(
    () => allocateCertifiedPayAmounts([], { deductions: "1.0000", net: "0.0000" }),
    HrmConstructionError,
  );
  assert.throws(
    () => allocateCertifiedPayAmounts([], { deductions: "0.0000", net: "-1.0000" }),
    HrmConstructionError,
  );
  assert.deepEqual(allocateCertifiedPayAmounts([], { deductions: "0.0000", net: "0.0000" }), []);
});

test("certified payroll preserves signed adjustments and large totals at ledger precision", () => {
  const allocated = allocateCertifiedPayAmounts(buckets, {
    deductions: "-999999999999.9999",
    net: "999999999999.9999",
  });
  for (const field of ["deductions", "net"] as const) {
    const total = allocated.reduce(
      (units, bucket) => units + BigInt(bucket[field].replace(".", "")),
      0n,
    );
    assert.equal(total, field === "deductions" ? -9999999999999999n : 9999999999999999n);
  }
  assert.equal(
    allocated[0]!.net,
    "400000000000.0001",
    "stable first largest bucket receives the remainder",
  );
});
