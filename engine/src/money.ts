/**
 * Exact money arithmetic on numeric(19,4) strings — BigInt scaled 1e4.
 * Never floats. The kernel's deferred balance trigger is the last line of
 * defense; this is the first.
 */
const SCALE = 10_000n;

export function toUnits(s: string | number): bigint {
  const str = String(s).trim();
  const neg = str.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? str.slice(1) : str).split(".");
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
