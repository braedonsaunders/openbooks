/**
 * Exact money arithmetic on numeric(19,4) strings — BigInt scaled 1e4.
 * Never floats. The kernel's deferred balance trigger is the last line of
 * defense; this is the first.
 */
const SCALE = 10_000n;

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
export const sum = (xs: string[]) => fromUnits(xs.reduce((acc, x) => acc + toUnits(x), 0n));
export const isZero = (a: string) => toUnits(a) === 0n;
export const cmp = (a: string, b: string) => {
  const d = toUnits(a) - toUnits(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};
