/**
 * Grant-date fair value of a share option by the Black-Scholes-Merton
 * formula with a continuous dividend yield:
 *
 *   C  = S·e^(−qT)·N(d1) − K·e^(−rT)·N(d2)
 *   d1 = (ln(S/K) + (r − q + σ²/2)·T) / (σ·√T),  d2 = d1 − σ·√T
 *
 * The transcendental functions are evaluated deterministically in bigint
 * fixed point with 80 decimal places: exp by range reduction to
 * [0, ln 2) and its Taylor series, ln by binary scaling and the atanh
 * series, square roots by integer Newton iteration, and the standard normal
 * distribution by the everywhere-convergent series
 *   N(x) = ½ + φ(x)·Σ x^(2n+1) / (1·3·5···(2n+1)),
 * with N(x) taken as exactly 0 or 1 beyond |x| > 13 (the tail is below
 * 10^-38). Truncation error stays many orders of magnitude below the stored
 * quantum, so the value rounded half up to ten decimal places is the same
 * on every machine. No binary floating point is involved.
 */
import { equityError, fig } from "./errors.ts";
import {
  compareRational,
  formatPrice,
  parsePercent,
  parsePrice,
  rational,
  type Rational,
} from "./quantities.ts";

const DIGITS = 80n;
const SCALE = 10n ** DIGITS;
const PI = fixedFromDecimal(
  "3.14159265358979323846264338327950288419716939937510582097494459230781640628620899862803482534211706798",
);
const NORMAL_TAIL_LIMIT = 13n * SCALE;

function fixedFromDecimal(text: string): bigint {
  const [whole = "0", fraction = ""] = text.split(".");
  return (
    BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(Number(DIGITS))).slice(0, Number(DIGITS)))
  );
}

function fixedFromRational(value: Rational): bigint {
  return (value.numerator * SCALE) / value.denominator;
}

const mul = (a: bigint, b: bigint): bigint => (a * b) / SCALE;
const div = (a: bigint, b: bigint): bigint => (a * SCALE) / b;

/** atanh(z) = z + z³/3 + z⁵/5 + … for 0 ≤ z < 1. */
function atanh(z: bigint): bigint {
  const z2 = mul(z, z);
  let power = z;
  let sum = z;
  for (let n = 3n; ; n += 2n) {
    power = mul(power, z2);
    const term = power / n;
    if (term === 0n) return sum;
    sum += term;
  }
}

const LN2 = 2n * atanh(div(SCALE, 3n * SCALE));

function exp(x: bigint): bigint {
  if (x < 0n) return div(SCALE, exp(-x));
  const k = x / LN2;
  const r = x - k * LN2;
  let term = SCALE;
  let sum = SCALE;
  for (let n = 1n; ; n += 1n) {
    term = mul(term, r) / n;
    if (term === 0n) break;
    sum += term;
  }
  return sum << k;
}

function ln(x: bigint): bigint {
  if (x <= 0n)
    throw equityError("valuationLogarithmUndefined", {
      sharePrice: fig.term("grantSharePrice"),
      exercisePrice: fig.term("exercisePrice"),
    });
  let k = 0n;
  let m = x;
  while (m >= 2n * SCALE) {
    m >>= 1n;
    k += 1n;
  }
  while (m < SCALE) {
    m <<= 1n;
    k -= 1n;
  }
  return 2n * atanh(div(m - SCALE, m + SCALE)) + k * LN2;
}

/** Floor square root: Newton's iteration from a power of two above the root decreases monotonically to it. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

const sqrt = (x: bigint): bigint => isqrt(x * SCALE);

/** Standard normal cumulative distribution function in fixed point. */
function normalCdf(x: bigint): bigint {
  if (x < 0n) return SCALE - normalCdf(-x);
  if (x > NORMAL_TAIL_LIMIT) return SCALE;
  const x2 = mul(x, x);
  const phi = div(exp(-(x2 / 2n)), sqrt(2n * PI));
  let term = x;
  let sum = x;
  for (let n = 1n; ; n += 1n) {
    term = mul(term, x2) / (2n * n + 1n);
    if (term === 0n) break;
    sum += term;
  }
  return SCALE / 2n + mul(phi, sum);
}

export interface BlackScholesInputs {
  /** Share price on the grant date (ten places). */
  sharePrice: string;
  /** Exercise price per share (ten places). */
  exercisePrice: string;
  volatilityPercent: string;
  riskFreeRatePercent: string;
  expectedTermYears: string;
  dividendYieldPercent: string;
}

export interface BlackScholesResult {
  /** Fair value per option, rounded half up to ten places. */
  fairValue: string;
  d1: string | null;
  d2: string | null;
}

const toRationalFixed = (value: bigint): Rational => rational(value, SCALE);

/** Black-Scholes-Merton value of a European call; missing or invalid inputs refuse by name. */
export function blackScholesCall(inputs: BlackScholesInputs): BlackScholesResult {
  const s = parsePrice(inputs.sharePrice, "grantSharePrice");
  const k = parsePrice(inputs.exercisePrice, "exercisePrice");
  const sigma = parsePercent(inputs.volatilityPercent, "volatilityPercent");
  const r = parsePercent(inputs.riskFreeRatePercent, "riskFreeRatePercent");
  const t = parsePrice(inputs.expectedTermYears, "expectedTermYears");
  const q = parsePercent(inputs.dividendYieldPercent, "dividendYieldPercent");
  const zero = rational(0n);
  if (compareRational(s, zero) <= 0)
    throw equityError(
      "valuationSharePriceNotPositive",
      { field: fig.term("grantSharePrice") },
      { field: "valuation" },
    );
  if (compareRational(k, zero) < 0)
    throw equityError(
      "valuationExercisePriceNegative",
      { field: fig.term("exercisePrice") },
      { field: "valuation" },
    );
  if (compareRational(sigma, zero) <= 0)
    throw equityError(
      "valuationVolatilityNotPositive",
      { field: fig.term("volatilityPercent") },
      { field: "valuation" },
    );
  if (compareRational(t, zero) <= 0)
    throw equityError(
      "valuationTermNotPositive",
      { field: fig.term("expectedTermYears") },
      { field: "valuation" },
    );
  if (compareRational(q, zero) < 0)
    throw equityError(
      "valuationDividendYieldNegative",
      { field: fig.term("dividendYieldPercent") },
      { field: "valuation" },
    );
  const S = fixedFromRational(s);
  const K = fixedFromRational(k);
  const sig = fixedFromRational(sigma);
  const rate = fixedFromRational(r);
  const T = fixedFromRational(t);
  const yieldRate = fixedFromRational(q);
  const discountedShare = mul(S, exp(-mul(yieldRate, T)));
  if (K === 0n)
    return { fairValue: formatPrice(toRationalFixed(discountedShare)), d1: null, d2: null };
  const volRoot = mul(sig, sqrt(T));
  const drift = mul(rate - yieldRate + mul(sig, sig) / 2n, T);
  const d1 = div(ln(div(S, K)) + drift, volRoot);
  const d2 = d1 - volRoot;
  const value =
    mul(discountedShare, normalCdf(d1)) - mul(mul(K, exp(-mul(rate, T))), normalCdf(d2));
  return {
    fairValue: formatPrice(toRationalFixed(value > 0n ? value : 0n)),
    d1: formatPrice(toRationalFixed(d1)),
    d2: formatPrice(toRationalFixed(d2)),
  };
}
