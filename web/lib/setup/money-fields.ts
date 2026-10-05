/**
 * Exact conversions between operator majors ("120.50") and storage minors
 * (12050) for setup `money` fields. Pure decimal-string arithmetic — never
 * floats — keyed by the currency's minor-unit precision. Unparseable input
 * and over-precise fractions refuse with a remedy instead of coercing: a
 * guessed rounding on someone's money is how you store an amount nobody
 * typed.
 */

const MAJOR_GRAMMAR = /^(\d+)(?:\.(\d+))?$/;

export function minorToMajor(minor: string | number | bigint, exponent: number): string | null {
  let units: bigint;
  try {
    units = typeof minor === 'bigint' ? minor : BigInt(String(minor).trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) return null;
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString();
  if (exponent === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(exponent + 1, '0');
  const head = padded.slice(0, -exponent);
  const tail = padded.slice(-exponent);
  return `${negative ? '-' : ''}${head}.${tail}`;
}

export type MajorToMinor =
  | { ok: true; minor: string }
  | { ok: false; reason: 'not-a-number' | 'too-precise' };

export function majorToMinor(major: string, exponent: number): MajorToMinor {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
    return { ok: false, reason: 'not-a-number' };
  }
  const text = major.trim();
  const match = MAJOR_GRAMMAR.exec(text);
  if (!match) return { ok: false, reason: 'not-a-number' };
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) {
    return { ok: false, reason: 'too-precise' };
  }
  const factor = 10n ** BigInt(exponent);
  const minor = BigInt(match[1]) * factor + BigInt((fraction + '0'.repeat(exponent)).slice(0, exponent) || '0');
  return { ok: true, minor: minor.toString() };
}
