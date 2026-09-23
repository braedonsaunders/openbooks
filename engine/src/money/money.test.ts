import assert from "node:assert/strict";
import test from "node:test";
import { abs, allocateLargestRemainder, cmp, div, divRate, formatMoney, isZero, mul, mulDecimal, mulDecimalFactors, mulPercent, mulRate, mulRatio, normalizeDecimal, normalizeMoney, prorateDays, roundDiv, roundMoney, sum, toUnits } from "./money.ts";

test("mul handles quantity math, zero rates and exact rounding", () => {
  assert.equal(mul("3", "12.3456"), "37.0368");
  assert.equal(mul("4", "0"), "0.0000");
  assert.equal(mul("-2", "1.2500"), "-2.5000");
  assert.equal(mul("0.3333", "3.0000"), "0.9999");
});

test("abs preserves exact four-decimal money units", () => {
  assert.equal(abs("-0.0001"), "0.0001");
  assert.equal(abs("12.3400"), "12.3400");
  assert.equal(abs("0"), "0.0000");
});

test("mulRate translates money exactly at numeric(19,10) precision", () => {
  assert.equal(mulRate("100.0000", "1.3512345678"), "135.1235");
  assert.equal(mulRate("-100.0000", "1.3512345678"), "-135.1235");
  assert.equal(mulRate("0.0100", "0.5000000000"), "0.0050");
});

test("mulRate rejects zero, negative, and over-precise rates", () => {
  assert.throws(() => mulRate("1", "0"), /greater than zero/);
  assert.throws(() => mulRate("1", "-1"), /positive FX rate/);
  assert.throws(() => mulRate("1", "1.00000000001"), /precision/);
});

test("mulPercent remains exact across the full numeric(19,4) money range", () => {
  assert.equal(mulPercent("900719925474099.1250", "13", 2), "117093590311632.8900");
  assert.equal(mulPercent("999999999999999.9500", "13", 2), "129999999999999.9900");
  assert.equal(mulPercent("-10.0500", "5", 2), "-0.5000");
  assert.equal(mulPercent("0.1000", "7.25", 4), "0.0073");
});

test("mulRatio allocates exact partial carrying values", () => {
  assert.equal(mulRatio("120.0000", 1n, 3n), "40.0000");
  assert.equal(mulRatio("100.0000", 1n, 6n), "16.6667");
  assert.equal(toUnits(mulRatio("100.0000", 5n, 6n)) + toUnits("16.6667"), toUnits("100.0000"));
});

test("prorateDays prices covered days, clamps coverage, zeroes degenerate periods", () => {
  // 15 of 31 July days of a 3000.00 allowance.
  assert.equal(prorateDays("3000.0000", 15, 31), "1451.6129");
  // Full coverage is exactly the full amount — no rounding dust.
  assert.equal(prorateDays("50.0000", 14, 14), "50.0000");
  // Over-coverage clamps; no coverage zeroes.
  assert.equal(prorateDays("50.0000", 99, 14), "50.0000");
  assert.equal(prorateDays("50.0000", 0, 14), "0.0000");
  assert.equal(prorateDays("50.0000", -3, 14), "0.0000");
  // A degenerate period prices as zero rather than throwing.
  assert.equal(prorateDays("50.0000", 3, 0), "0.0000");
});

test("normalization and rational rounding never depend on binary floats", () => {
  assert.equal(normalizeMoney("00012.3"), "12.3000");
  assert.equal(normalizeDecimal("43.566784", 8), "43.56678400");
  assert.equal(normalizeDecimal("-2.5e-3", 8), "-0.00250000");
  assert.throws(() => normalizeDecimal("1.000000001", 8), /precision/);
  assert.equal(roundDiv(5n, 2n), 3n);
  assert.equal(roundDiv(-5n, 2n), -3n);
});

test("roundMoney and formatMoney round exact ledger units without binary drift", () => {
  assert.equal(roundMoney("900719925474099.9950", 2), "900719925474100.0000");
  assert.equal(formatMoney("1.0050", 2), "1.01");
  assert.equal(formatMoney("-1.0050", 2), "-1.01");
});

test("decimal factors preserve ten-place rates and combine before rounding", () => {
  assert.equal(mulDecimal("900719925474099.1250", "0.13"), "117093590311632.8863");
  assert.equal(mulDecimalFactors("10000", ["0.3", "0.5"]), "1500.0000");
});

test("div is the non-FX counterpart to divRate", () => {
  assert.equal(div("100.0000", "8"), "12.5000");
  assert.equal(div("1", "3"), "0.3333");
  assert.equal(div("2", "3"), "0.6667"); // halves away from zero
  // A negative divisor is a real quantity (a credit line), unlike an FX rate.
  assert.equal(div("100.0000", "-8"), "-12.5000");
  assert.equal(div("-100.0000", "8"), "-12.5000");
  assert.equal(div("0", "8"), "0.0000");
  // Quantities carry eight decimals; a four-decimal divisor would truncate.
  assert.equal(div("100", "0.00000001"), divRate("100", "0.00000001"));
  assert.equal(div("12.3456", "1.00000001"), divRate("12.3456", "1.00000001"));
});

test("div matches divRate exactly wherever divRate is legal", () => {
  for (const pair of [
    ["100", "3"], ["0.0001", "7"], ["-250.5000", "1.25"],
    ["999999.9999", "0.0001"], ["12.3456", "2.50000000"],
  ]) {
    const a = pair[0]!;
    const b = pair[1]!;
    assert.equal(div(a, b), divRate(a, b), `${a} / ${b}`);
  }
});

test("div rejects only zero, and says what actually went wrong", () => {
  // divRate would call this an FX-rate fault; a zero quantity is not currency.
  assert.throws(() => div("100", "0"), /cannot divide "100" by zero/);
  assert.throws(() => div("100", "0.0000"), /by zero/);
});

test("scientific exponents beyond the shared resource bound are rejected before allocation", () => {
  // Guard: if the bound ever regresses, these inputs must fail here instead
  // of attempting a ~1GB pad/repeat allocation in the test runner.
  const prototype = String.prototype as unknown as Record<
    "padEnd" | "padStart" | "repeat",
    (this: string, ...args: unknown[]) => string
  >;
  const saved = {
    padEnd: prototype.padEnd,
    padStart: prototype.padStart,
    repeat: prototype.repeat,
  };
  const failOnBulkAlloc = (label: "padEnd" | "padStart" | "repeat") =>
    function (this: string, ...args: unknown[]): string {
      if (Number(args[0]) > 1_000_000) {
        throw new Error(`test guard: ${label}(${String(args[0])}) would allocate`);
      }
      return saved[label].call(this, ...args);
    };
  prototype.padEnd = failOnBulkAlloc("padEnd");
  prototype.padStart = failOnBulkAlloc("padStart");
  prototype.repeat = failOnBulkAlloc("repeat");
  try {
    for (const input of ["1e1000000000", "1e-1000000000", "1E1000000000", "1E-1000000000"]) {
      assert.throws(() => toUnits(input), /supported range/, `toUnits(${input})`);
      assert.throws(() => normalizeDecimal(input), /supported range/, `normalizeDecimal(${input})`);
      assert.throws(() => normalizeDecimal(input, 10), /supported range/);
    }
    // Unsafe and infinite exponents never reach expansion either.
    assert.throws(() => toUnits("1e99999999999999999"), /supported range/);
    assert.throws(() => normalizeDecimal(`1e${"9".repeat(400)}`), /supported range/);
    // Just past the bound fails closed — even for an exact zero.
    assert.throws(() => toUnits("1e10001"), /supported range/);
    assert.throws(() => normalizeDecimal("1e-10001", 10), /supported range/);
    assert.throws(() => normalizeDecimal("0e1000000000", 8), /supported range/);
  } finally {
    prototype.padEnd = saved.padEnd;
    prototype.padStart = saved.padStart;
    prototype.repeat = saved.repeat;
  }
  // The bound itself and legitimate connector notation still expand exactly.
  assert.equal(toUnits("1e10000"), 10n ** 10004n);
  assert.equal(toUnits("1.2355303E7"), 123553030000n);
  assert.equal(toUnits("-2.5e-3"), -25n);
  assert.equal(normalizeDecimal("1e4", 8), "10000.00000000");
  assert.equal(normalizeDecimal("-2.5e-3", 8), "-0.00250000");
});

test("div then mul returns the original within one rounding step", () => {
  // Compared in exact ledger units — a money test must not measure itself with
  // binary floats. Re-multiplying a rounded share can be off by at most half a
  // unit per whole of the divisor.
  for (const pair of [["100", "3"], ["7.5000", "4"], ["0.0001", "7"], ["-100", "3"]]) {
    const amount = pair[0]!;
    const divisor = pair[1]!;
    const back = mul(div(amount, divisor), divisor);
    const drift = toUnits(back) - toUnits(amount);
    const bound = (toUnits(divisor) + 2n * 10_000n) / (2n * 10_000n);
    assert.ok(
      (drift < 0n ? -drift : drift) <= bound,
      `${amount}/${divisor} drifted ${drift} units (bound ${bound})`,
    );
  }
});

test("roundDiv rounds halves away from zero on both sides of zero", () => {
  // A truncating-division swap returns 0 for every |n| < d row here; a
  // half-even swap flips the exact-half rows (1/2, 5/2, 6/4, -5/2).
  const cases: Array<[bigint, bigint, bigint]> = [
    [1n, 2n, 1n],
    [3n, 2n, 2n],
    [5n, 2n, 3n],
    [7n, 4n, 2n],
    [6n, 4n, 2n],
    [10n, 4n, 3n],
    [4n, 2n, 2n],
    [0n, 7n, 0n],
    [-1n, 2n, -1n],
    [-3n, 2n, -2n],
    [-5n, 2n, -3n],
    [-6n, 4n, -2n],
    [-10n, 4n, -3n],
  ];
  for (const [numerator, denominator, expected] of cases) {
    assert.equal(roundDiv(numerator, denominator), expected, `${numerator}/${denominator}`);
  }
  assert.throws(() => roundDiv(1n, 0n), /denominator must be greater than zero/);
  assert.throws(() => roundDiv(1n, -2n), /denominator must be greater than zero/);
});

test("mul rounds a half-unit product away from zero instead of truncating it", () => {
  // 0.0001 × 0.5 is exactly half a ledger unit: truncation posts 0.0000 and
  // silently destroys the half cent; a sign flip posts the wrong side.
  assert.equal(mul("0.0001", "0.5000"), "0.0001");
  assert.equal(mul("-0.0001", "0.5000"), "-0.0001");
  assert.equal(mul("0.0001", "-0.5000"), "-0.0001");
  assert.equal(mul("-0.0001", "-0.5000"), "0.0001");
  assert.equal(mul("0.0002", "0.2500"), "0.0001");
  assert.equal(mul("2.6750", "1.0000"), "2.6750");
});

test("mulRate rounds a half-unit translation away from zero on both signs", () => {
  // 0.0001 at a 0.5 rate is exactly half a functional unit — the same
  // boundary the FX residual absorber assumes each line can carry.
  assert.equal(mulRate("0.0001", "0.5000000000"), "0.0001");
  assert.equal(mulRate("-0.0001", "0.5000000000"), "-0.0001");
  assert.equal(mulRate("0.0001", "1.0000000000"), "0.0001");
  assert.equal(mulRate("0.0003", "0.5000000000"), "0.0002");
  assert.equal(mulRate("-0.0003", "0.5000000000"), "-0.0002");
});

test("mulRatio keeps dust shares visible and signs them with the amount", () => {
  // A truncating swap zeroes every dust row; a sign flip credits the residue.
  const cases: Array<[string, bigint, bigint, string]> = [
    ["0.0001", 1n, 2n, "0.0001"],
    ["0.0002", 1n, 4n, "0.0001"],
    ["-0.0001", 1n, 2n, "-0.0001"],
    ["-0.0002", 1n, 4n, "-0.0001"],
    ["100.0000", 1n, 3n, "33.3333"],
    ["100.0000", 2n, 3n, "66.6667"],
    ["0.0001", 1n, 1n, "0.0001"],
  ];
  for (const [amount, numerator, denominator, expected] of cases) {
    assert.equal(mulRatio(amount, numerator, denominator), expected, `${amount} × ${numerator}/${denominator}`);
  }
  // Complementary shares bracket the whole: floor + ceiling, never two floors.
  assert.equal(
    toUnits(mulRatio("100.0000", 1n, 3n)) + toUnits(mulRatio("100.0000", 2n, 3n)),
    toUnits("100.0000"),
  );
  assert.throws(() => mulRatio("100.0000", -1n, 3n), /numerator cannot be negative/);
  assert.throws(() => mulRatio("100.0000", 1n, 0n), /denominator must be greater than zero/);
});

test("mulPercent rounds a half-quantum levy away from zero on both signs", () => {
  // 0.0001 at 50% is exactly half a unit; 100 at 0.0001% is one dust unit.
  assert.equal(mulPercent("0.0001", "50"), "0.0001");
  assert.equal(mulPercent("-0.0001", "50"), "-0.0001");
  assert.equal(mulPercent("100.0000", "0.0001"), "0.0001");
  assert.equal(mulPercent("-100.0000", "0.0001"), "-0.0001");
  assert.equal(mulPercent("0.0003", "50"), "0.0002");
  assert.equal(mulPercent("200.0000", "7.25"), "14.5000");
  assert.equal(mulPercent("-200.0000", "7.25"), "-14.5000");
  assert.throws(() => mulPercent("100", "5", 5), /decimalPlaces/);
  assert.throws(() => mulPercent("100", "5", -1), /decimalPlaces/);
});

test("div rounds a half-quantum quotient away from zero on both signs", () => {
  // 1 ÷ 20000 is exactly half a unit: truncation posts 0.0000 and the
  // divisor's value vanishes from the ledger.
  assert.equal(div("1", "20000"), "0.0001");
  assert.equal(div("-1", "20000"), "-0.0001");
  assert.equal(div("1", "-20000"), "-0.0001");
  assert.equal(div("-1", "-20000"), "0.0001");
  assert.equal(div("3", "20000"), "0.0002");
});

test("decimal spellings canonicalize without binary floats", () => {
  // A spelling-sensitive mutant (string compare, or kept raw text) fails the
  // zero and padding rows; a float-based rewrite fails the long rows.
  const spellings: Array<[string, string]> = [
    ["+1.5", "1.5000"],
    [".5", "0.5000"],
    ["5.", "5.0000"],
    ["00012.30", "12.3000"],
    ["-0.0000", "0.0000"],
    ["-0", "0.0000"],
    ["900719925474099.9999", "900719925474099.9999"],
    ["-900719925474099.9999", "-900719925474099.9999"],
  ];
  for (const [input, expected] of spellings) {
    assert.equal(normalizeMoney(input), expected, `normalizeMoney(${input})`);
  }
  for (const bad of ["1.00005", "-0.00001", "abc", "", "1.2.3", "--1"]) {
    assert.throws(() => normalizeMoney(bad), Error, `normalizeMoney(${bad})`);
  }
});

test("normalizeDecimal pins quantity scale without touching money precision", () => {
  assert.equal(normalizeDecimal("1.5", 4), "1.5000");
  assert.equal(normalizeDecimal("1.2300", 2), "1.23");
  assert.equal(normalizeDecimal("-0", 2), "0.00");
  assert.equal(normalizeDecimal("-0.0000", 4), "0.0000");
  assert.equal(normalizeDecimal("1.23456789", 8), "1.23456789");
  assert.equal(normalizeDecimal("1e4", 4), "10000.0000");
  assert.equal(normalizeDecimal("5", 0), "5");
  assert.equal(normalizeDecimal("5.0", 0), "5");
  assert.throws(() => normalizeDecimal("0.5", 0), /precision/);
  assert.throws(() => normalizeDecimal("1.234567891", 8), /precision/);
  assert.throws(() => normalizeDecimal("abc", 4), /not a decimal/);
  assert.throws(() => normalizeDecimal("1.5", 11), /decimalPlaces/);
  assert.throws(() => normalizeDecimal("1.5", -1), /decimalPlaces/);
  assert.throws(() => normalizeDecimal("1.5", 1.5), /decimalPlaces/);
});

test("decimal factors accept signed, whole and leading-dot spellings exactly", () => {
  // A sign-class mutant ([++] strips nothing, [--] keeps the plus, +units on
  // the negate path) flips or rejects every negative factor; a whole-part
  // mutant (whole * RATE_SCALE swapped to /) zeroes every factor at or above
  // one; a spelling mutant (\\d+ mangled to \\d-) rejects leading-dot input.
  assert.equal(mulDecimal("100", "-0.5"), "-50.0000");
  assert.equal(mulDecimal("100", "-12.5"), "-1250.0000");
  assert.equal(mulDecimal("100", "+0.5"), "50.0000");
  assert.equal(mulDecimalFactors("100", [".5"]), "50.0000");
  assert.equal(mulDecimalFactors("100", ["-2", "0.5"]), "-100.0000");
  assert.equal(mulDecimal("100", "2"), "200.0000");
  assert.equal(mulDecimalFactors("100", ["1.5"]), "150.0000");
});

test("decimal factors refuse precision beyond ten places but keep exact tails", () => {
  // Every guard mutant here silently truncates or wrongly rejects: a
  // widened length bound (> 11), a shifted slice (11), a widened digit
  // class ([2-9], [1-8], [1-10]) or a narrowed one ([0-9]).
  for (const bad of ["0.00000000005", "0.00000000001", "0.00000000009", "1.00000000001"]) {
    assert.throws(() => mulDecimal("1", bad), /precision/, `factor ${bad}`);
  }
  assert.equal(mulDecimal("1", "0.1234567891"), "0.1235");
  assert.equal(mulDecimal("1", "0.12345678900"), "0.1235");
  // Eleven digits with a nonzero tenth place and a zero tail is still exact:
  // a slice shifted to 9 reads the 9 and wrongly refuses it.
  assert.equal(mulDecimal("1", "0.12345678910"), "0.1235");
});

test("scientific notation edges expand exactly", () => {
  // An explicit plus exponent, a unit exponent, a negative exponent, and a
  // negative exponent on a multi-digit whole part each pin one mutation of
  // the sign strip, the exponent match, or the exp > 0 / exp < 0 branches.
  assert.equal(toUnits("1e+5"), 1000000000n);
  assert.equal(toUnits("1.5e1"), 150000n);
  assert.equal(toUnits("1.5e-1"), 1500n);
  assert.equal(toUnits("12.34e-1"), 12340n);
});

test("money inputs tolerate trailing zeros but refuse hidden precision", () => {
  // A narrowed digit class ([0-9]) rejects the exact zero tail; a shifted
  // slice (3) throws on it instead; a widened class ([1-8]) silently drops
  // a real ninth-decimal digit.
  assert.equal(normalizeMoney("1.23450"), "1.2345");
  assert.equal(normalizeMoney("1.20000"), "1.2000");
  assert.throws(() => normalizeMoney("1.00009"), /precision/);
});

test("sum, isZero and cmp cover the empty, signed and equal rows", () => {
  // The sum seed, the isZero comparison, and both cmp branches have no
  // coverage: a shifted seed posts dust on every empty sum, a flipped
  // isZero treats dust as zero (or zero as dust), and a widened cmp
  // reports equality as over- or under-payment.
  assert.equal(sum([]), "0.0000");
  assert.equal(sum(["1.5000", "2.2500", "-0.2500"]), "3.5000");
  assert.equal(isZero("0"), true);
  assert.equal(isZero("-0.0000"), true);
  assert.equal(isZero("0.0001"), false);
  assert.equal(isZero("-0.0001"), false);
  assert.equal(cmp("1.5000", "1.5000"), 0);
  assert.equal(cmp("1.4000", "1.5000"), -1);
  assert.equal(cmp("1.6000", "1.5000"), 1);
});

test("boundary precisions stay legal at zero and full scale", () => {
  // A narrowed guard (<= 0, <= 0n, >= 4) rejects the legal zero/full-scale
  // row; a widened one (< 0n) lets the zero denominator fall through to the
  // wrong error, which the message match pins to the right guard.
  assert.equal(mulPercent("200.0000", "7.25", 0), "15.0000");
  assert.equal(mulRatio("100.0000", 0n, 3n), "0.0000");
  assert.equal(roundMoney("1.2345", 4), "1.2345");
  assert.throws(() => mulRatio("100.0000", 1n, 0n), /ratio denominator must be greater than zero/);
  assert.throws(() => divRate("1", "0"), /FX rate must be greater than zero/);
});

test("roundMoney and formatMoney keep the sign honest at every scale", () => {
  // Away-from-zero must keep a negative sign when the rounded value is
  // nonzero, and must not invent one when dust rounds to zero.
  assert.equal(roundMoney("-1.0050", 2), "-1.0100");
  assert.equal(roundMoney("1.0049", 2), "1.0000");
  assert.equal(roundMoney("2.6750", 2), "2.6800");
  assert.equal(roundMoney("1.2345", 3), "1.2350");
  assert.equal(roundMoney("-1.2345", 3), "-1.2350");
  assert.equal(roundMoney("-0.0049", 2), "0.0000");
  assert.equal(formatMoney("2.6750", 2), "2.68");
  assert.equal(formatMoney("-0.0050", 2), "-0.01");
  assert.equal(formatMoney("-0.0049", 2), "0.00");
  assert.equal(formatMoney("100", 0), "100");
  assert.equal(formatMoney("-100.5", 0), "-101");
  assert.equal(formatMoney("0.0049", 2), "0.00");
  assert.throws(() => roundMoney("1.5", 5), /decimalPlaces/);
});

test("allocateLargestRemainder keeps the invoice total equal to the approved total", () => {
  // The finding: two 0.0050 draws round independently to 0.02 against an
  // approved 0.01. Largest remainder deals the single cent to the first
  // line by tie order, so the lines sum to the rounded total exactly.
  assert.deepEqual(allocateLargestRemainder(["0.0050", "0.0050"]), ["0.0100", "0.0000"]);
  assert.deepEqual(allocateLargestRemainder(["0.0033", "0.0033", "0.0034"]), ["0.0000", "0.0000", "0.0100"]);
  // Whole-cent inputs pass through untouched.
  assert.deepEqual(allocateLargestRemainder(["1.2500", "2.5000"]), ["1.2500", "2.5000"]);
  // A single half rounds the way roundMoney rounds it (away from zero).
  assert.deepEqual(allocateLargestRemainder(["0.0050"]), ["0.0100"]);
  assert.deepEqual(allocateLargestRemainder(["-0.0050"]), ["-0.0100"]);
  // Credit lines allocate symmetrically: a negative outstanding takes
  // cents from the most negative remainders first.
  assert.deepEqual(allocateLargestRemainder(["-0.0050", "-0.0050"]), ["-0.0100", "0.0000"]);
  // Mixed signs whose fractions cancel allocate to zeros, not to mirrored halves.
  assert.deepEqual(allocateLargestRemainder(["10.0050", "-0.0050"]), ["10.0000", "0.0000"]);
  // Empty input allocates nothing; bad precision refuses.
  assert.deepEqual(allocateLargestRemainder([]), []);
  assert.throws(() => allocateLargestRemainder(["1.0000"], 5), /decimalPlaces/);
});

test("allocateLargestRemainder always cross-foots to the rounded total", () => {
  const cases: string[][] = [
    ["0.0050", "0.0050"],
    ["0.0049", "0.0049", "0.0049"],
    ["100.1150", "0.0050", "-50.0050"],
    ["-0.0050", "-0.0050", "-0.0050"],
    ["0.0001", "0.0001", "0.0001"],
    ["999.9950", "0.0050"],
  ];
  for (const exact of cases) {
    const allocated = allocateLargestRemainder(exact);
    assert.equal(
      sum(allocated),
      roundMoney(sum(exact), 2),
      `allocated ${JSON.stringify(allocated)} must sum to the rounded total of ${JSON.stringify(exact)}`,
    );
    assert.equal(allocated.length, exact.length);
  }
});
