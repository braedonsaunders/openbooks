import assert from "node:assert/strict";
import test from "node:test";
import {
  computeLineTax,
  computeLineTaxes,
  resolveLineTax,
  TaxCalculationError,
  taxVaries,
} from "./tax.ts";
import { requireEffectiveRateRow } from "./tax-persist.ts";

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

// Synthetic compound taxes exercise the generic calculator; they are not Québec GST/QST.
test("exclusive compound components use the ordered prior-tax basis", () => {
  const result = computeLineTaxes("100.0000", [
    code({ taxCodeId: "base-tax", sequence: 1, ratePercent: "5" }),
    code({
      taxCodeId: "compound-tax",
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
      taxCodeId: "base-tax",
      sequence: 1,
      ratePercent: "5",
      priceIncludesTax: true,
    }),
    code({
      taxCodeId: "compound-tax",
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

test("a lapsed rate schedule is refused while a statutory zero rate stays legal", () => {
  // Regression: the effective-rate lateral joins used to coalesce a MISSING
  // rate row to 0%, so lapsed or misdated schedules posted real documents at
  // 0% with full calculation evidence. "No row matched the document date" is
  // now a precise failure naming the code and date…
  const err = (() => {
    try {
      requireEffectiveRateRow("GB-VAT-STD", "2026-07-01", null);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof TaxCalculationError);
  assert.match(err.message, /GB-VAT-STD/);
  assert.match(err.message, /2026-07-01/);
  // …whereas a MATCHED row carrying 0% remains a legitimate statutory zero
  // rate (zero-rated supplies exist) and flows through unchanged.
  assert.equal(requireEffectiveRateRow("GB-VAT-ZERO", "2026-07-01", "0.0000"), "0.0000");
});

test("negative and non-exact tax rates are refused at the calculation boundary", () => {
  // The rate domain is one contract with the setup API and storage
  // (numeric(19,4), nonnegative): what cannot be configured must not
  // calculate either, and the refusal is the engine's own error type.
  assert.throws(
    () => computeLineTaxes("100", [code({ ratePercent: "-13" })]),
    (e: unknown) => e instanceof TaxCalculationError && /tax rate cannot be negative/.test(e.message),
  );
  for (const invalid of ["not-a-rate", "", "13.00005"]) {
    assert.throws(
      () => computeLineTaxes("100", [code({ ratePercent: invalid })]),
      (e: unknown) =>
        e instanceof TaxCalculationError && /exact decimal with at most 4 decimal places/.test(e.message),
      `rate "${invalid}" must be refused`,
    );
  }
  assert.throws(
    () => computeLineTaxes("100", [code({ recoverablePercent: "a few" })]),
    (e: unknown) => e instanceof TaxCalculationError && /recoverable percentage/.test(e.message),
  );
});

test("override variance trips just past a half cent", () => {
  // taxVaries is the half-cent ($0.0050) tolerance on manual overrides: a
  // 51-unit variance varies, a 50-unit variance does not. The boundary is
  // exact — shifting it by one unit hides real variances from reviewers.
  assert.equal(resolveLineTax("100", "5").computed, "5.0000");
  assert.equal(
    taxVaries(resolveLineTax("100", "5", { overridden: true, taxAmount: "5.0050" })),
    false,
  );
  assert.equal(
    taxVaries(resolveLineTax("100", "5", { overridden: true, taxAmount: "5.0051" })),
    true,
  );
  assert.equal(
    taxVaries(resolveLineTax("100", "5", { overridden: true, taxAmount: "4.9950" })),
    false,
  );
  assert.equal(
    taxVaries(resolveLineTax("100", "5", { overridden: true, taxAmount: "4.9949" })),
    true,
  );
  assert.equal(taxVaries(resolveLineTax("100", "5")), false);
});

test("a dust-positive override on a negative line is still a sign mismatch", () => {
  // The sign guard refuses ANY positive override on a negative amount — even
  // one unit ($0.0001). Relaxing the comparison lets a positive override slip
  // into the magnitude path and post with the wrong sign.
  assert.throws(
    () =>
      computeLineTaxes("-100", [code()], {
        overridden: true,
        taxAmount: "0.0001",
      }),
    /same sign/,
  );
});

test("a statutory zero rate calculates exact zero tax", () => {
  const result = computeLineTaxes("100.0000", [code({ ratePercent: "0" })]);
  assert.equal(result.netAmount, "100.0000");
  assert.equal(result.taxTotal, "0.0000");
  assert.equal(result.total, "100.0000");
  assert.equal(result.components[0]!.ratePercent, "0.0000");
  assert.equal(result.components[0]!.taxAmount, "0.0000");
});

test("recoverable bounds reject below-zero and above-100 ratios, accept the edges", () => {
  // The range guard is a strict < 0 / > 100 pair: a fully nonrecoverable
  // "0" is legitimate input, while even one unit outside refuses.
  assert.throws(
    () => computeLineTaxes("100.0000", [code({ recoverablePercent: "-0.0001" })]),
    TaxCalculationError,
  );
  assert.throws(
    () => computeLineTaxes("100.0000", [code({ recoverablePercent: "100.0001" })]),
    TaxCalculationError,
  );
  const zero = computeLineTaxes("100.0000", [code({ recoverablePercent: "0" })]);
  assert.equal(zero.components[0]!.recoverableAmount, "0.0000");
  assert.equal(zero.components[0]!.nonrecoverableAmount, "13.0000");
});

test("rounding scale accepts the full 0..4 range and refuses anything else", () => {
  const r0 = computeLineTaxes("100.0000", [code({ roundingScale: 0 })]);
  assert.equal(r0.components[0]!.taxAmount, "13.0000");
  const r4 = computeLineTaxes("100.0000", [code({ roundingScale: 4 })]);
  assert.equal(r4.components[0]!.taxAmount, "13.0000");
  assert.throws(() => computeLineTaxes("100.0000", [code({ roundingScale: 5 })]), TaxCalculationError);
  assert.throws(() => computeLineTaxes("100.0000", [code({ roundingScale: -1 })]), TaxCalculationError);
});

test("a zero-amount inclusive line extracts a zero net instead of refusing", () => {
  const r = computeLineTaxes("0.0000", [code({ priceIncludesTax: true })]);
  assert.equal(r.netAmount, "0.0000");
  assert.equal(r.taxTotal, "0.0000");
  assert.equal(r.total, "0.0000");
});

test("negative taxable amounts calculate the magnitude and reapply the sign", () => {
  const r = computeLineTaxes("-100.0000", [code({ ratePercent: "10" })]);
  assert.equal(r.inputAmount, "-100.0000");
  assert.equal(r.netAmount, "-100.0000");
  assert.equal(r.taxTotal, "-10.0000");
  assert.equal(r.total, "-110.0000");
  assert.equal(r.components[0]!.taxAmount, "-10.0000");
  const negatedOverride = computeLineTaxes("-100.0000", [code({ ratePercent: "10" })], {
    overridden: true,
    taxAmount: "-12.0000",
  });
  assert.equal(negatedOverride.taxTotal, "-12.0000");
  // A one-unit negative amount with a positive override is still a mismatch —
  // the sign path is decided by strict negativity, not magnitude.
  assert.throws(
    () =>
      computeLineTaxes("-0.0001", [code({ ratePercent: "10" })], {
        overridden: true,
        taxAmount: "5.0000",
      }),
    /same sign/,
  );
});

test("a zero override on a negative line is not a sign mismatch", () => {
  // The sign guard refuses strictly positive overrides; an exact zero carries
  // no sign and flows into the magnitude path.
  const r = computeLineTaxes("-100.0000", [code({ ratePercent: "10" })], {
    overridden: true,
    taxAmount: "0.0000",
  });
  assert.equal(r.taxTotal, "0.0000");
});

test("a zero-amount line takes the positive path, never the magnitude recursion", () => {
  const z = computeLineTaxes("0.0000", [code({ ratePercent: "10" })]);
  assert.equal(z.taxTotal, "0.0000");
  assert.equal(z.total, "0.0000");
});

test("a manual override preserves the configured recovery ratio on zero-tax lines", () => {
  // With no explicit ratio and equal zero amounts, the evidence heuristic is
  // full recovery — not the zero-recovery guess the old equality check made.
  const r = computeLineTaxes(
    "100.0000",
    [{ taxCodeId: "t", sequence: 1, ratePercent: "0" }],
    { overridden: true, taxAmount: "5.0000" },
  );
  assert.equal(r.components[0]!.taxAmount, "5.0000");
  assert.equal(r.components[0]!.recoverablePercent, "100.0000");
  assert.equal(r.components[0]!.recoverableAmount, "5.0000");
});

test("a manual override scales partial recovery proportionally", () => {
  const r = computeLineTaxes("100.0000", [code({ ratePercent: "10", recoverablePercent: "50" })], {
    overridden: true,
    taxAmount: "12.0000",
  });
  assert.equal(r.components[0]!.taxAmount, "12.0000");
  assert.equal(r.components[0]!.recoverableAmount, "6.0000");
  assert.equal(r.components[0]!.nonrecoverableAmount, "6.0000");
});

test("a manual override cannot drive a component negative, even by one unit", () => {
  assert.throws(
    () =>
      computeLineTaxes("100.0000", [code({ ratePercent: "10" })], {
        overridden: true,
        taxAmount: "-0.0001",
      }),
    /cannot make a component negative/,
  );
  const zeroed = computeLineTaxes("100.0000", [code({ ratePercent: "10" })], {
    overridden: true,
    taxAmount: "0.0000",
  });
  assert.equal(zeroed.components[0]!.taxAmount, "0.0000");
  assert.equal(zeroed.components[0]!.recoverableAmount, "0.0000");
});

test("price-inclusive extraction inverts an exclusive calculation with no residue flag", () => {
  // An exact inversion leaves no rounding residue, so no component is marked
  // overridden. Running the reconciler unconditionally would flag it.
  const r = computeLineTaxes("110.0000", [code({ ratePercent: "10", priceIncludesTax: true })]);
  assert.equal(r.netAmount, "100.0000");
  assert.equal(r.taxTotal, "10.0000");
  assert.equal(r.total, "110.0000");
  assert.equal(r.overridden, false);
});

test("an unreachable inclusive gross parks a positive residue on the final component", () => {
  // 104.0000 is unreachable at 10%-rounded-to-whole (nets 94/95 gross to
  // 103/105). The search settles deterministically and the reconciler books
  // the one-unit residue to the final included component, flagged overridden.
  const r = computeLineTaxes("104.0000", [code({ ratePercent: "10", roundingScale: 0, priceIncludesTax: true })]);
  assert.equal(r.netAmount, "94.9999");
  assert.equal(r.taxTotal, "9.0001");
  assert.equal(r.total, "104.0000");
  assert.equal(r.overridden, true);
});

test("an unreachable inclusive gross parks a negative residue on the final component", () => {
  // Mirror image: 104.9999 settles on net 95.0000 whose statutory whole-unit
  // tax (10.0000) overshoots by one unit, so the residue adjusts downward.
  const r = computeLineTaxes("104.9999", [code({ ratePercent: "10", roundingScale: 0, priceIncludesTax: true })]);
  assert.equal(r.netAmount, "95.0000");
  assert.equal(r.taxTotal, "9.9999");
  assert.equal(r.total, "104.9999");
  assert.equal(r.overridden, true);
});

test("the search never skips candidates when narrowing the inclusive net", () => {
  // 148.0000 is unreachable at 10%-rounded-to-whole. Stepping the low bound
  // by two instead of one converges past the closest net (134.9999, one unit
  // away) onto 135.0000 (a full unit away) — same cross-foot, wrong split
  // between income and tax. The search must advance one unit at a time.
  const r = computeLineTaxes("148.0000", [code({ ratePercent: "10", roundingScale: 0, priceIncludesTax: true })]);
  assert.equal(r.netAmount, "134.9999");
  assert.equal(r.taxTotal, "13.0001");
  assert.equal(r.total, "148.0000");
  assert.equal(r.overridden, true);
});

test("the half-cent variance tolerance is exact at fifty units", () => {
  assert.equal(taxVaries({ computed: "10.0000", overridden: true, taxAmount: "10.0050" }), false);
  assert.equal(taxVaries({ computed: "10.0000", overridden: true, taxAmount: "10.0051" }), true);
  assert.equal(taxVaries({ computed: "10.0000", overridden: false, taxAmount: "99.0000" }), false);
});

test("a line with no tax profile passes its amount through untouched", () => {
  const r = computeLineTaxes("100.0000", []);
  assert.equal(r.netAmount, "100.0000");
  assert.equal(r.taxTotal, "0.0000");
  assert.equal(r.total, "100.0000");
  assert.deepEqual(r.components, []);
  assert.equal(r.overridden, false);
});
