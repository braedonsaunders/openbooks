import assert from "node:assert/strict";
import test from "node:test";
import {
  computeLineTax,
  computeLineTaxes,
  TaxCalculationError,
} from "./tax.ts";

const code = (
  overrides: Partial<Parameters<typeof computeLineTaxes>[1][number]> = {},
) => ({
  taxCodeId: overrides.taxCodeId ?? `tax-${overrides.sequence ?? 1}`,
  sequence: overrides.sequence ?? 1,
  ratePercent: overrides.ratePercent ?? "13",
  recoverablePercent: overrides.recoverablePercent ?? "100",
  ...overrides,
});

test("line tax is exact beyond Number.MAX_SAFE_INTEGER", () => {
  assert.equal(
    computeLineTax("900719925474099.1250", "13"),
    "117093590311632.8900",
  );
  assert.equal(
    computeLineTax("999999999999999.9500", "13"),
    "129999999999999.9900",
  );
});

test("exclusive compound components use the ordered prior-tax basis", () => {
  const result = computeLineTaxes("100.0000", [
    code({ taxCodeId: "gst", sequence: 1, ratePercent: "5" }),
    code({
      taxCodeId: "qst",
      sequence: 2,
      ratePercent: "9.975",
      compoundOnPrevious: true,
    }),
  ]);
  assert.equal(result.netAmount, "100.0000");
  assert.deepEqual(
    result.components.map((c) => [c.taxableAmount, c.taxAmount]),
    [
      ["100.0000", "5.0000"],
      ["105.0000", "10.4700"],
    ],
  );
  assert.equal(result.taxTotal, "15.4700");
  assert.equal(result.total, "115.4700");
});

test("inclusive compound tax extracts a net that cross-foots exactly", () => {
  const result = computeLineTaxes("115.4700", [
    code({
      taxCodeId: "gst",
      sequence: 1,
      ratePercent: "5",
      priceIncludesTax: true,
    }),
    code({
      taxCodeId: "qst",
      sequence: 2,
      ratePercent: "9.975",
      priceIncludesTax: true,
      compoundOnPrevious: true,
    }),
  ]);
  assert.equal(result.netAmount, "100.0000");
  assert.equal(result.taxTotal, "15.4700");
  assert.equal(result.total, "115.4700");
});

test("purchase recoverability splits the component without changing supplier settlement", () => {
  const result = computeLineTaxes("100.0000", [
    code({ ratePercent: "20", recoverablePercent: "40" }),
  ]);
  assert.equal(result.components[0]!.taxAmount, "20.0000");
  assert.equal(result.components[0]!.recoverableAmount, "8.0000");
  assert.equal(result.components[0]!.nonrecoverableAmount, "12.0000");
  assert.equal(result.total, "120.0000");
});

test("withholding reduces settlement while reverse charge leaves it unchanged", () => {
  const result = computeLineTaxes("100.0000", [
    code({
      taxCodeId: "withhold",
      sequence: 1,
      ratePercent: "10",
      calculationType: "withholding",
    }),
    code({
      taxCodeId: "reverse",
      sequence: 2,
      ratePercent: "20",
      calculationType: "reverse_charge",
      recoverablePercent: "75",
    }),
  ]);
  assert.equal(result.taxTotal, "-10.0000");
  assert.equal(result.total, "90.0000");
  assert.deepEqual(
    result.components.map((c) => c.taxAmount),
    ["10.0000", "20.0000"],
  );
  assert.equal(result.components[1]!.recoverableAmount, "15.0000");
  assert.equal(result.components[1]!.nonrecoverableAmount, "5.0000");
});

test("manual overrides are explicit and preserve the component cross-foot", () => {
  const result = computeLineTaxes("100", [code()], {
    overridden: true,
    taxAmount: "12.99",
  });
  assert.equal(result.taxTotal, "12.9900");
  assert.equal(result.total, "112.9900");
  assert.equal(result.components[0]!.overridden, true);
});

test("negative taxable lines preserve exact signed tax symmetry", () => {
  const result = computeLineTaxes("-100", [code()]);
  assert.equal(result.netAmount, "-100.0000");
  assert.equal(result.taxTotal, "-13.0000");
  assert.equal(result.total, "-113.0000");
  assert.deepEqual(
    result.components.map((component) => ({
      taxable: component.taxableAmount,
      tax: component.taxAmount,
      recoverable: component.recoverableAmount,
      nonrecoverable: component.nonrecoverableAmount,
    })),
    [
      {
        taxable: "-100.0000",
        tax: "-13.0000",
        recoverable: "-13.0000",
        nonrecoverable: "0.0000",
      },
    ],
  );
});

test("negative source tax overrides stay signed and exact", () => {
  const result = computeLineTaxes("-100", [code()], {
    overridden: true,
    taxAmount: "-12.99",
  });
  assert.equal(result.taxTotal, "-12.9900");
  assert.equal(result.components[0]?.taxAmount, "-12.9900");
  assert.throws(
    () =>
      computeLineTaxes("-100", [code()], {
        overridden: true,
        taxAmount: "12.99",
      }),
    /same sign/,
  );
});

test("invalid mixed inclusive behavior and non-tax inclusive types are refused", () => {
  assert.throws(
    () =>
      computeLineTaxes("100", [
        code({ taxCodeId: "a", priceIncludesTax: true }),
        code({ taxCodeId: "b", sequence: 2 }),
      ]),
    TaxCalculationError,
  );
  assert.throws(
    () =>
      computeLineTaxes("100", [
        code({ priceIncludesTax: true, calculationType: "withholding" }),
      ]),
    TaxCalculationError,
  );
});
