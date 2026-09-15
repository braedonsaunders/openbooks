import assert from "node:assert/strict";
import test from "node:test";
import { abs, div, divRate, formatMoney, mul, mulDecimal, mulDecimalFactors, mulPercent, mulRate, mulRatio, normalizeDecimal, normalizeMoney, roundDiv, roundMoney, toUnits } from "./money.ts";

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
