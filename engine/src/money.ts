/**
 * Exact money arithmetic on numeric(19,4) strings — BigInt scaled 1e4.
 * Never floats. The kernel's deferred balance trigger is the last line of
 * defense; this is the first.
 */
const SCALE = 10_000n;
const RATE_SCALE = 10_000_000_000n;

export function toUnits(s: string | number): bigint {
  let str = String(s).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(str)) {
    throw new Error(`not a decimal number: "${s}"`);
  }
  const neg = str.startsWith("-");
  str = str.replace(/^[-+]/, "");

  // expand scientific notation (SuiteQL emits e.g. "1.2355303E7")
  let exp = 0;
  const em = str.match(/[eE]([-+]?\d+)$/);
  if (em) {
    exp = parseInt(em[1], 10);
    str = str.slice(0, em.index);
  }
  let [intPart, fracPart = ""] = str.split(".");
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
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const rounded = (absolute + RATE_SCALE / 2n) / RATE_SCALE;
  return fromUnits(negative ? -rounded : rounded);
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
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + rateUnits / 2n) / rateUnits;
  return fromUnits(negative ? -rounded : rounded);
}
