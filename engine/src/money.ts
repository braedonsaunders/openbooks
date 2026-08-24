/**
 * Exact money arithmetic on numeric(19,4) strings — BigInt scaled 1e4.
 * Never floats. The kernel's deferred balance trigger is the last line of
 * defense; this is the first.
 */
const SCALE = 10_000n;
const RATE_SCALE = 10_000_000_000n;

function decimalFactorUnits(value: string | number): bigint {
  const raw = String(value).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) throw new Error(`not a decimal factor: "${value}"`);
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[-+]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > 10 && /[1-9]/.test(fraction.slice(10))) {
    throw new Error(`decimal factor loses precision beyond 10 decimal places: "${value}"`);
  }
  const units = BigInt(whole || "0") * RATE_SCALE + BigInt((fraction + "0".repeat(10)).slice(0, 10));
  return negative ? -units : units;
}

/** Round an exact rational to the nearest integer, halves away from zero. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be greater than zero");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

export function toUnits(s: string | number): bigint {
  let str = String(s).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(str)) {
    throw new Error(`not a decimal number: "${s}"`);
  }
  const neg = str.startsWith("-");
  str = str.replace(/^[-+]/, "");

  // Expand scientific notation emitted by some connector APIs (for example, "1.2355303E7").
  let exp = 0;
  const em = str.match(/[eE]([-+]?\d+)$/);
  if (em) {
    exp = parseInt(em[1]!, 10);
    str = str.slice(0, em.index);
  }
  let [intPart = "", fracPart = ""] = str.split(".");
  if (exp > 0) {
    fracPart = fracPart.padEnd(exp, "0");
    intPart = intPart + fracPart.slice(0, exp);
    fracPart = fracPart.slice(exp);
  } else if (exp < 0) {
    intPart = intPart.padStart(-exp, "0");
    fracPart = intPart.slice(exp) + fracPart;
    intPart = intPart.slice(0, exp) || "0";
  }

  if (fracPart.length > 4 && /[1-9]/.test(fracPart.slice(4))) {
    throw new Error(`loses precision beyond 4 decimal places: "${s}"`);
  }
  const frac = (fracPart + "0000").slice(0, 4);
  const units = BigInt(intPart || "0") * SCALE + BigInt(frac);
  return neg ? -units : units;
}

export function fromUnits(u: bigint): string {
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const int = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(4, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

export const add = (a: string, b: string) => fromUnits(toUnits(a) + toUnits(b));
export const neg = (a: string) => fromUnits(-toUnits(a));
export const abs = (a: string) => {
  const units = toUnits(a);
  return fromUnits(units < 0n ? -units : units);
};
export const sum = (xs: string[]) => fromUnits(xs.reduce((acc, x) => acc + toUnits(x), 0n));
export const isZero = (a: string) => toUnits(a) === 0n;
export const cmp = (a: string, b: string) => {
  const d = toUnits(a) - toUnits(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};

/** Multiply two numeric(19,4) values with exact round-half-up semantics.
 * Unlike mulRate, zero and negative operands are valid: this is quantity ×
 * unit amount, not an FX conversion. */
export function mul(a: string, b: string): string {
  const product = toUnits(a) * toUnits(b);
  return fromUnits(roundDiv(product, SCALE));
}

/**
 * Divide money by a quantity or rate — an amount over a quantity, a balance
 * over a wage — rounded to 4 decimals, halves away from zero.
 *
 * The non-FX counterpart to `divRate`, and numerically identical to it: the
 * divisor is read at ten decimal places, because quantities are not money
 * (`document_lines.quantity` is numeric(28,8)) and truncating one to four
 * decimals would silently change unit rates.
 *
 * What differs is what it refuses. `divRate` rejects zero and negatives as
 * invalid exchange rates; here a negative divisor is an ordinary credit
 * quantity, and a zero divisor is an empty quantity or an unset wage — which
 * this says plainly instead of reporting a currency fault.
 */
export function div(a: string, b: string): string {
  const raw = String(b).trim();
  const negative = raw.startsWith("-");
  const magnitude = negative ? raw.slice(1) : raw;
  if (!/^\+?(\d+(\.\d*)?|\.\d+)$/.test(magnitude)) {
    throw new Error(`not a numeric divisor: "${b}"`);
  }
  const [whole = "0", fraction = ""] = magnitude.replace(/^\+/, "").split(".");
  if (fraction.length > 10 && /[1-9]/.test(fraction.slice(10))) {
    throw new Error(`divisor loses precision beyond 10 decimal places: "${b}"`);
  }
  const divisorUnits =
    BigInt(whole || "0") * RATE_SCALE + BigInt((fraction + "0".repeat(10)).slice(0, 10));
  if (divisorUnits === 0n) throw new Error(`cannot divide "${a}" by zero`);
  const quotient = roundDiv(toUnits(a) * RATE_SCALE, divisorUnits);
  return fromUnits(negative ? -quotient : quotient);
}

/** Multiply money by one or more exact decimal factors (up to 10dp each). */
export function mulDecimalFactors(amount: string, factors: readonly (string | number)[]): string {
  let numerator = toUnits(amount);
  let denominator = 1n;
  for (const factor of factors) {
    numerator *= decimalFactorUnits(factor);
    denominator *= RATE_SCALE;
  }
  return fromUnits(roundDiv(numerator, denominator));
}

export function mulDecimal(amount: string, factor: string | number): string {
  return mulDecimalFactors(amount, [factor]);
}

/**
 * Multiply money by a percentage without crossing JavaScript's floating-point
 * boundary. Both inputs are exact numeric(19,4) strings; `13.25` means 13.25%.
 * The result is rounded half-away-from-zero to `decimalPlaces` (0..4), while
 * remaining represented as the ledger's canonical four-decimal money string.
 */
export function mulPercent(amount: string, percent: string, decimalPlaces = 4): string {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 4) {
    throw new Error("decimalPlaces must be an integer from 0 through 4");
  }
  const quantum = 10n ** BigInt(4 - decimalPlaces);
  const roundedQuanta = roundDiv(
    toUnits(amount) * toUnits(percent),
    100n * SCALE * quantum,
  );
  return fromUnits(roundedQuanta * quantum);
}

/** Exact proportional money allocation, rounded to ledger precision. */
export function mulRatio(amount: string, numerator: bigint, denominator: bigint): string {
  if (numerator < 0n) throw new Error("ratio numerator cannot be negative");
  if (denominator <= 0n) throw new Error("ratio denominator must be greater than zero");
  return fromUnits(roundDiv(toUnits(amount) * numerator, denominator));
}

/** Canonicalize a money input to the ledger's numeric(19,4) representation. */
export function normalizeMoney(value: string | number): string {
  return fromUnits(toUnits(value));
}

/**
 * Canonicalize a non-money decimal without crossing the IEEE-754 boundary.
 * Quantities and commercial rates legitimately carry more precision than
 * posted money, so callers choose an explicit scale (up to 10 places).
 */
export function normalizeDecimal(
  value: string | number,
  decimalPlaces = 8,
): string {
  if (
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0 ||
    decimalPlaces > 10
  ) {
    throw new Error("decimalPlaces must be an integer from 0 through 10");
  }
  let raw = String(value).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
    throw new Error(`not a decimal number: "${value}"`);
  }
  const negative = raw.startsWith("-");
  raw = raw.replace(/^[-+]/, "");
  let exponent = 0;
  const exponentMatch = raw.match(/[eE]([-+]?\d+)$/);
  if (exponentMatch) {
    exponent = Number(exponentMatch[1]);
    raw = raw.slice(0, exponentMatch.index);
  }
  const [wholePart = "0", fractionPart = ""] = raw.split(".");
  let digits = `${wholePart}${fractionPart}`;
  if (!digits) digits = "0";
  let decimalIndex = wholePart.length + exponent;
  if (decimalIndex <= 0) {
    digits = `${"0".repeat(-decimalIndex)}${digits}`;
    decimalIndex = 0;
  } else if (decimalIndex >= digits.length) {
    digits = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
    decimalIndex = digits.length;
  }
  let whole = digits.slice(0, decimalIndex) || "0";
  let fraction = digits.slice(decimalIndex);
  if (
    fraction.length > decimalPlaces &&
    /[1-9]/.test(fraction.slice(decimalPlaces))
  ) {
    throw new Error(
      `decimal loses precision beyond ${decimalPlaces} decimal places: "${value}"`,
    );
  }
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  fraction = fraction.slice(0, decimalPlaces).padEnd(decimalPlaces, "0");
  const isZero = whole === "0" && !/[1-9]/.test(fraction);
  return `${negative && !isZero ? "-" : ""}${whole}${
    decimalPlaces > 0 ? `.${fraction}` : ""
  }`;
}

/** Round a ledger value to a requested precision without binary floating point. */
export function roundMoney(value: string | number, decimalPlaces = 4): string {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 4) {
    throw new Error("decimalPlaces must be an integer from 0 through 4");
  }
  const quantum = 10n ** BigInt(4 - decimalPlaces);
  return fromUnits(roundDiv(toUnits(value), quantum) * quantum);
}

/** Fixed-width exact decimal formatting, used by settlement/export formats. */
export function formatMoney(value: string | number, decimalPlaces = 2): string {
  const rounded = roundMoney(value, decimalPlaces);
  const [whole, fraction = ""] = rounded.split(".");
  return decimalPlaces === 0 ? whole! : `${whole}.${fraction.slice(0, decimalPlaces)}`;
}

/**
 * Multiply a numeric(19,4) transaction amount by a numeric(19,10) FX rate,
 * returning the functional-currency amount rounded to 4 decimals. Keeping the
 * rate arithmetic here avoids the float drift that would otherwise make a
 * multi-line foreign-currency journal miss the kernel's balance constraint.
 */
export function mulRate(amount: string, rate: string): string {
  const raw = String(rate).trim();
  if (!/^\+?(\d+(\.\d*)?|\.\d+)$/.test(raw)) {
    throw new Error(`not a positive FX rate: "${rate}"`);
  }
  const unsigned = raw.replace(/^\+/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > 10 && /[1-9]/.test(fraction.slice(10))) {
    throw new Error(`FX rate loses precision beyond 10 decimal places: "${rate}"`);
  }
  const rateUnits = BigInt(whole || "0") * RATE_SCALE + BigInt((fraction + "0".repeat(10)).slice(0, 10));
  if (rateUnits <= 0n) throw new Error(`FX rate must be greater than zero: "${rate}"`);

  const product = toUnits(amount) * rateUnits;
  return fromUnits(roundDiv(product, RATE_SCALE));
}

/** Divide functional-currency money by an FX rate, rounded to 4 decimals. */
export function divRate(amount: string, rate: string): string {
  const raw = String(rate).trim();
  if (!/^\+?(\d+(\.\d*)?|\.\d+)$/.test(raw)) throw new Error(`not a positive FX rate: "${rate}"`);
  const [whole = "0", fraction = ""] = raw.replace(/^\+/, "").split(".");
  if (fraction.length > 10 && /[1-9]/.test(fraction.slice(10))) {
    throw new Error(`FX rate loses precision beyond 10 decimal places: "${rate}"`);
  }
  const rateUnits = BigInt(whole || "0") * RATE_SCALE + BigInt((fraction + "0".repeat(10)).slice(0, 10));
  if (rateUnits <= 0n) throw new Error(`FX rate must be greater than zero: "${rate}"`);
  const numerator = toUnits(amount) * RATE_SCALE;
  return fromUnits(roundDiv(numerator, rateUnits));
}
