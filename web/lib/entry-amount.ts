import { roundDiv } from "@openbooks/engine/money/money";

/**
 * Amount entry for transaction forms: what a clerk types into a money cell
 * becomes the exact ledger amount.
 *
 *  - Arithmetic: `200+47.83`, `=12*4.5`, `(100-15)/2` are evaluated exactly
 *    (rational bigint arithmetic, one rounding at the end to the ledger's
 *    four decimal places, halves away from zero), the way adding machines
 *    and desktop accounting packages always allowed.
 *  - Auto decimal: with the personal preference on, a run of digits places
 *    the decimal point before the currency's minor units (`1785` → 17.85)
 *    for ten-key typists.
 *
 * Nothing here coerces separators: a comma is never read as a decimal or
 * grouping mark, so an amount is either exact or refused.
 */

const LEDGER_SCALE = 10_000n;

/** A rational number with a positive denominator. */
interface Rational {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x || 1n;
}

function reduce(value: Rational): Rational {
  if (value.d === 0n) throw new Error("division by zero");
  const sign = value.d < 0n ? -1n : 1n;
  const divisor = gcd(value.n, value.d);
  return { n: (sign * value.n) / divisor, d: (sign * value.d) / divisor };
}

function parseDecimalLiteral(literal: string): Rational {
  const [whole = "0", fraction = ""] = literal.split(".");
  if (fraction.length > 18) throw new Error("too many decimal places");
  return reduce({ n: BigInt((whole || "0") + fraction), d: 10n ** BigInt(fraction.length) });
}

type Token =
  { kind: "number"; value: Rational } | { kind: "op"; value: "+" | "-" | "*" | "/" | "(" | ")" };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === " ") {
      index += 1;
      continue;
    }
    if ("+-*/()".includes(char)) {
      tokens.push({ kind: "op", value: char as "+" });
      index += 1;
      continue;
    }
    if (char === "×" || char === "x" || char === "X") {
      tokens.push({ kind: "op", value: "*" });
      index += 1;
      continue;
    }
    if (char === "÷") {
      tokens.push({ kind: "op", value: "/" });
      index += 1;
      continue;
    }
    const match = /^(\d+(\.\d*)?|\.\d+)/.exec(source.slice(index));
    if (!match) throw new Error("unexpected character");
    tokens.push({ kind: "number", value: parseDecimalLiteral(match[0]) });
    index += match[0].length;
  }
  return tokens;
}

/** Recursive-descent evaluation: expression := term (('+'|'-') term)*; term := factor (('*'|'/') factor)*. */
function evaluate(tokens: Token[]): Rational {
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  function factor(): Rational {
    const token = take();
    if (!token) throw new Error("incomplete expression");
    if (token.kind === "number") return token.value;
    if (token.value === "-") {
      const inner = factor();
      return { n: -inner.n, d: inner.d };
    }
    if (token.value === "+") return factor();
    if (token.value === "(") {
      const inner = expression();
      const close = take();
      if (!close || close.kind !== "op" || close.value !== ")")
        throw new Error("unbalanced parentheses");
      return inner;
    }
    throw new Error("unexpected operator");
  }
  function term(): Rational {
    let value = factor();
    for (
      let next = peek();
      next && next.kind === "op" && (next.value === "*" || next.value === "/");
      next = peek()
    ) {
      take();
      const right = factor();
      value =
        next.value === "*"
          ? reduce({ n: value.n * right.n, d: value.d * right.d })
          : reduce({ n: value.n * right.d, d: value.d * right.n });
    }
    return value;
  }
  function expression(): Rational {
    let value = term();
    for (
      let next = peek();
      next && next.kind === "op" && (next.value === "+" || next.value === "-");
      next = peek()
    ) {
      take();
      const right = term();
      const sign = next.value === "+" ? 1n : -1n;
      value = reduce({ n: value.n * right.d + sign * right.n * value.d, d: value.d * right.d });
    }
    return value;
  }
  const result = expression();
  if (position !== tokens.length) throw new Error("trailing input");
  return result;
}

function toLedgerString(value: Rational): string {
  const units = roundDiv(value.n * LEDGER_SCALE, value.d);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / LEDGER_SCALE;
  const fraction = (magnitude % LEDGER_SCALE).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** True when the text is arithmetic rather than a plain number. */
export function isAmountExpression(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("=") || /\d\s*[-+*/×÷xX]\s*[\d.(]/.test(trimmed) || /^[-+]?\(/.test(trimmed)
  );
}

export type EnteredAmount =
  { kind: "empty" } | { kind: "amount"; value: string; computed: boolean } | { kind: "invalid" };

/**
 * Resolve typed text to a ledger amount (numeric(19,4) canonical string).
 * `minorUnits` is the currency's decimal places for auto decimal (2 for USD,
 * 0 for JPY, 3 for BHD).
 */
export function resolveEnteredAmount(
  text: string,
  options: { autoDecimal?: boolean; minorUnits?: number } = {},
): EnteredAmount {
  let source = text.trim();
  if (source === "") return { kind: "empty" };
  if (source.startsWith("=")) source = source.slice(1);
  const minorUnits = options.minorUnits ?? 2;
  if (
    options.autoDecimal &&
    !isAmountExpression(text) &&
    minorUnits > 0 &&
    /^[+-]?\d+$/.test(source)
  ) {
    const negative = source.startsWith("-");
    const digits = source.replace(/^[+-]/, "").padStart(minorUnits + 1, "0");
    source = `${negative ? "-" : ""}${digits.slice(0, -minorUnits)}.${digits.slice(-minorUnits)}`;
  }
  try {
    const computed = isAmountExpression(text);
    if (!computed && !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(source)) return { kind: "invalid" };
    const rational = evaluate(tokenize(source));
    if (!computed && (rational.n * LEDGER_SCALE) % rational.d !== 0n) return { kind: "invalid" };
    const value = toLedgerString(rational);
    // Fifteen whole digits is the ledger's numeric(19,4) range.
    if (value.replace("-", "").split(".")[0]!.length > 15) return { kind: "invalid" };
    return { kind: "amount", value, computed };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * How a stored amount reads in an editable cell: storage-scale zeroes beyond
 * the currency's minor units are dropped (247.8300 → 247.83, 1785.0000 →
 * 1785.00) while any significant fraction digit is kept exactly.
 */
export function displayEnteredAmount(value: unknown, minorUnits = 2): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const match = /^(-?\d+)\.(\d+)$/.exec(text);
  if (!match)
    return /^-?\d+$/.test(text) && minorUnits > 0 ? `${text}.${"0".repeat(minorUnits)}` : text;
  const [, whole, fraction] = match;
  const trimmed = fraction!.replace(/0+$/, "");
  const kept =
    trimmed.length >= minorUnits ? trimmed : fraction!.slice(0, minorUnits).padEnd(minorUnits, "0");
  return kept.length > 0 ? `${whole}.${kept}` : whole!;
}

/**
 * A spreadsheet-copied amount. Accepts what Excel and Sheets put on the
 * clipboard for an en-style number: optional currency symbol, a trailing or
 * leading minus, accounting parentheses for negatives, and comma grouping
 * only in its unambiguous form (groups of exactly three digits before a
 * decimal point, or several such groups). Anything else is refused rather
 * than guessed.
 */
export function parsePastedAmount(text: string): string | null {
  let source = text
    .trim()
    .replace(/^[$€£¥₹]\s*/, "")
    .replace(/\s*[$€£¥₹]$/, "");
  if (source === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(source)) {
    negative = true;
    source = source.slice(1, -1).trim();
  }
  if (source.endsWith("-")) {
    negative = !negative;
    source = source.slice(0, -1);
  }
  if (source.startsWith("-")) {
    negative = !negative;
    source = source.slice(1);
  }
  source = source.replace(/^[$€£¥₹]\s*/, "");
  const grouped =
    /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(source) &&
    (source.includes(".") || (source.match(/,/g)?.length ?? 0) > 1);
  if (grouped) source = source.replace(/,/g, "");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(source)) return null;
  const resolved = resolveEnteredAmount(`${negative ? "-" : ""}${source}`);
  return resolved.kind === "amount" ? resolved.value : null;
}
