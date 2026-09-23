/**
 * Safe Excel-style formula evaluator — a faithful implementation of
 * Lib_Core.evaluateFormula/tokenizeFormula (recursive descent, no eval).
 * Supports ternary (? :), || &&, == !=, < <= > >=, + - * / %, unary ! + -,
 * parens, and the functions min/max/ceil/floor/round/sqrt/pow/abs/avg.
 * Division and modulo by zero return 0 (defined semantics).
 *
 * Exact-decimal domain: every literal is parsed as an exact rational and
 * +, -, *, /, %, comparisons, min/max/avg/abs/ceil/floor/round are computed
 * exactly on that rational — `0.1 + 0.2 == 0.3` is true here, where IEEE-754
 * says it is false. The result is rounded half-away-from-zero to the
 * ledger's numeric(19,4) scale and returned as a canonical money string
 * ("100.0000", never 100 or "100.00"). The two approximative boundary
 * functions are sqrt and non-integer pow: an exact rational result need not
 * exist (sqrt(2)), so they compute in double precision and quantize to 4dp.
 * Integer-exponent pow stays exact.
 */

// Relative (not the bare workspace specifier): worktree node_modules resolves
// bare @openbooks/* to the main checkout, so a relative import binds this
// checkout everywhere (the same reason open-items.ts imports records
// relatively).
import { fromUnits, roundDiv } from "../../../engine/src/money/money.ts";

type Token =
  | { type: 'number'; value: string; pos: number }
  | { type: 'identifier'; value: string; pos: number }
  | { type: 'operator'; value: string; pos: number }
  | { type: 'paren'; value: string; pos: number }
  | { type: 'comma'; value: string; pos: number };

/** A decimal literal that survived strict validation: digits with at most one point. */
const STRICT_LITERAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function tokenizeFormula(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const twoChar = source.substring(index, index + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(twoChar)) {
      tokens.push({ type: 'operator', value: twoChar, pos: index });
      index += 2;
      continue;
    }
    if ('+-*/%?:><!'.includes(char)) {
      tokens.push({ type: 'operator', value: char, pos: index });
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char, pos: index });
      index += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ type: 'comma', value: char, pos: index });
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const start = index;
      let end = index + 1;
      while (end < source.length && /[0-9.]/.test(source[end]!)) end += 1;
      const literal = source.substring(start, end);
      // A second dot (or a bare point) is not a number followed by more
      // number: "1.2.3" must refuse naming its position, never evaluate the
      // parseFloat prefix 1.2 and silently drop ".3".
      if (!STRICT_LITERAL.test(literal)) {
        throw new Error(`Malformed numeric literal "${literal}" at position ${start}`);
      }
      tokens.push({ type: 'number', value: literal, pos: start });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1;
      tokens.push({ type: 'identifier', value: source.substring(start, end), pos: start });
      index = end;
      continue;
    }
    throw new Error(`Unsupported character "${char}" in formula at position ${index}`);
  }
  return tokens;
}

/** Exact rational with a positive denominator, always reduced. */
interface Decimal {
  num: bigint;
  den: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
};

const decimal = (num: bigint, den: bigint): Decimal => {
  if (den === 0n) throw new Error('Zero denominator in formula decimal');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return g === 0n ? { num: 0n, den: 1n } : { num: num / g, den: den / g };
};

const ZERO: Decimal = { num: 0n, den: 1n };
const ONE: Decimal = { num: 1n, den: 1n };

/** Parse a strictly-validated literal ("12", "12.34", ".5", "1.") exactly. */
function parseLiteral(literal: string): Decimal {
  const negative = literal.startsWith('-');
  const unsigned = negative ? literal.slice(1) : literal;
  const dot = unsigned.indexOf('.');
  if (dot === -1) return decimal(BigInt(unsigned || '0'), 1n);
  const intPart = unsigned.slice(0, dot) || '0';
  const fracPart = unsigned.slice(dot + 1);
  const num = BigInt(intPart + fracPart || '0');
  const den = 10n ** BigInt(fracPart.length);
  const value = decimal(num, den);
  return negative ? { num: -value.num, den: value.den } : value;
}

/** Parse the decimal expansion of a double (sqrt / non-integer pow path), exponent included. */
function parseFloatExpansion(value: number): Decimal {
  if (!Number.isFinite(value)) throw new Error('Non-finite intermediate in formula');
  let text = String(value);
  let exp = 0;
  const em = text.match(/[eE]([-+]?\d+)$/);
  if (em) {
    exp = Number(em[1]);
    text = text.slice(0, em.index);
  }
  if (!STRICT_LITERAL.test(text)) throw new Error(`Non-decimal intermediate "${text}" in formula`);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const dot = unsigned.indexOf('.');
  const intPart = (dot === -1 ? unsigned : unsigned.slice(0, dot)) || '0';
  const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1);
  let digits = intPart + fracPart;
  let point = intPart.length + exp;
  if (point <= 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  } else if (point >= digits.length) {
    digits = digits + '0'.repeat(point - digits.length);
  }
  const whole = digits.slice(0, point) || '0';
  const frac = digits.slice(point);
  const parsed = decimal(BigInt(whole + frac || '0'), 10n ** BigInt(frac.length));
  return negative ? { num: -parsed.num, den: parsed.den } : parsed;
}

const toFloat = (v: Decimal): number => Number(v.num) / Number(v.den);

const addDecimal = (a: Decimal, b: Decimal): Decimal =>
  decimal(a.num * b.den + b.num * a.den, a.den * b.den);
const subDecimal = (a: Decimal, b: Decimal): Decimal =>
  decimal(a.num * b.den - b.num * a.den, a.den * b.den);
const mulDecimalExact = (a: Decimal, b: Decimal): Decimal =>
  decimal(a.num * b.num, a.den * b.den);
const negDecimal = (a: Decimal): Decimal => ({ num: -a.num, den: a.den });
const absDecimal = (a: Decimal): Decimal => ({ num: a.num < 0n ? -a.num : a.num, den: a.den });
const cmpDecimal = (a: Decimal, b: Decimal): number => {
  const d = a.num * b.den - b.num * a.den;
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};
/** Truncated division quotient (toward zero), for %. */
const truncQuotient = (a: Decimal, b: Decimal): bigint => (a.num * b.den) / (b.num * a.den);
/** Floored division quotient, for floor/ceil/round. */
const floorQuotient = (num: bigint, den: bigint): bigint => {
  const q = num / den;
  return num >= 0n || num % den === 0n ? q : q - 1n;
};

type Value = Decimal | boolean;
const toDecimal = (v: Value): Decimal => (typeof v === 'boolean' ? (v ? ONE : ZERO) : v);
const toBoolean = (v: Value): boolean => (typeof v === 'boolean' ? v : v.num !== 0n);

function executeFormulaFunction(name: string, args: Value[]): Decimal {
  const n = args.map(toDecimal);
  switch (name) {
    case 'min': return n.length ? n.reduce((a, b) => (cmpDecimal(a, b) <= 0 ? a : b)) : ZERO;
    case 'max': return n.length ? n.reduce((a, b) => (cmpDecimal(a, b) >= 0 ? a : b)) : ZERO;
    case 'ceil': {
      const v = n[0] ?? ZERO;
      return decimal(floorQuotient(-v.num, v.den) * -1n, 1n);
    }
    case 'floor': {
      const v = n[0] ?? ZERO;
      return decimal(floorQuotient(v.num, v.den), 1n);
    }
    case 'round': {
      // Math.round semantics: halves toward +Infinity (round(-0.5) is -0).
      const v = n[0] ?? ZERO;
      return decimal(floorQuotient(v.num * 2n + v.den, v.den * 2n), 1n);
    }
    case 'sqrt': {
      const v = n[0] ?? ZERO;
      if (cmpDecimal(v, ZERO) < 0) throw new Error('sqrt of a negative value in formula');
      return parseFloatExpansion(Math.sqrt(toFloat(v)));
    }
    case 'pow': {
      const base = n[0] ?? ZERO;
      const exp = n[1] ?? ZERO;
      if (exp.den === 1n) {
        // Integer exponents stay exact, including negatives.
        let e = exp.num;
        let b = base;
        if (e < 0n) {
          if (b.num === 0n) throw new Error('pow with zero base and negative exponent in formula');
          b = decimal(b.den, b.num);
          e = -e;
        }
        let result: Decimal = ONE;
        while (e > 0n) {
          if (e % 2n === 1n) result = mulDecimalExact(result, b);
          b = mulDecimalExact(b, b);
          e /= 2n;
        }
        return result;
      }
      return parseFloatExpansion(Math.pow(toFloat(base), toFloat(exp)));
    }
    case 'abs': return absDecimal(n[0] ?? ZERO);
    case 'avg': {
      if (!n.length) return ZERO;
      let sum: Decimal = ZERO;
      for (const v of n) sum = addDecimal(sum, v);
      return decimal(sum.num, sum.den * BigInt(n.length));
    }
    default: throw new Error(`Unsupported formula function: ${name}`);
  }
}

/** Canonical numeric(19,4) rendering of an exact result, halves away from zero. */
function renderMoney(value: Decimal): string {
  return fromUnits(roundDiv(value.num * 10_000n, value.den));
}

export function evaluateFormula(expression: string): string {
  const source = String(expression || '').trim();
  if (!source) throw new Error('Formula is empty');

  const tokens = tokenizeFormula(source);
  let position = 0;

  const peek = () => tokens[position];
  const advance = () => tokens[position++];
  const match = (type: Token['type'], value?: string): boolean => {
    const token = peek();
    if (!token || token.type !== type) return false;
    if (value !== undefined && token.value !== value) return false;
    position += 1;
    return true;
  };
  const expect = (type: Token['type'], value?: string): Token => {
    const token = advance();
    if (!token || token.type !== type || (value !== undefined && token.value !== value)) {
      if (!token) throw new Error('Unexpected end of formula');
      const at = value !== undefined ? ` "${value}"` : '';
      throw new Error(`Expected${at} at position ${token.pos}, found "${token.value}"`);
    }
    return token;
  };

  function parseExpression(): Value {
    return parseTernary();
  }
  function parseTernary(): Value {
    const condition = parseLogicalOr();
    if (match('operator', '?')) {
      const whenTrue = parseExpression();
      expect('operator', ':');
      const whenFalse = parseExpression();
      return toBoolean(condition) ? whenTrue : whenFalse;
    }
    return condition;
  }
  function parseLogicalOr(): Value {
    let value = parseLogicalAnd();
    // Both sides always parse: short-circuiting the call would leave the
    // right side's tokens unconsumed and misreport them as trailing content.
    while (match('operator', '||')) {
      const rhs = parseLogicalAnd();
      value = toBoolean(value) || toBoolean(rhs);
    }
    return value;
  }
  function parseLogicalAnd(): Value {
    let value = parseEquality();
    while (match('operator', '&&')) {
      const rhs = parseEquality();
      value = toBoolean(value) && toBoolean(rhs);
    }
    return value;
  }
  function parseEquality(): Value {
    let value = parseComparison();
    for (;;) {
      if (match('operator', '==')) value = cmpDecimal(toDecimal(value), toDecimal(parseComparison())) === 0;
      else if (match('operator', '!=')) value = cmpDecimal(toDecimal(value), toDecimal(parseComparison())) !== 0;
      else return value;
    }
  }
  function parseComparison(): Value {
    let value = parseAdditive();
    for (;;) {
      if (match('operator', '>=')) value = cmpDecimal(toDecimal(value), toDecimal(parseAdditive())) >= 0;
      else if (match('operator', '<=')) value = cmpDecimal(toDecimal(value), toDecimal(parseAdditive())) <= 0;
      else if (match('operator', '>')) value = cmpDecimal(toDecimal(value), toDecimal(parseAdditive())) > 0;
      else if (match('operator', '<')) value = cmpDecimal(toDecimal(value), toDecimal(parseAdditive())) < 0;
      else return value;
    }
  }
  function parseAdditive(): Value {
    let value = parseMultiplicative();
    for (;;) {
      if (match('operator', '+')) value = addDecimal(toDecimal(value), toDecimal(parseMultiplicative()));
      else if (match('operator', '-')) value = subDecimal(toDecimal(value), toDecimal(parseMultiplicative()));
      else return value;
    }
  }
  function parseMultiplicative(): Value {
    let value = parseUnary();
    for (;;) {
      if (match('operator', '*')) value = mulDecimalExact(toDecimal(value), toDecimal(parseUnary()));
      else if (match('operator', '/')) {
        const divisor = toDecimal(parseUnary());
        value = divisor.num === 0n ? ZERO : decimal(toDecimal(value).num * divisor.den, toDecimal(value).den * divisor.num);
      } else if (match('operator', '%')) {
        const divisor = toDecimal(parseUnary());
        if (divisor.num === 0n) {
          value = ZERO;
        } else {
          const left = toDecimal(value);
          const q = truncQuotient(left, divisor);
          value = subDecimal(left, mulDecimalExact(divisor, decimal(q, 1n)));
        }
      } else return value;
    }
  }
  function parseUnary(): Value {
    if (match('operator', '!')) return !toBoolean(parseUnary());
    if (match('operator', '+')) return toDecimal(parseUnary());
    if (match('operator', '-')) return negDecimal(toDecimal(parseUnary()));
    return parsePrimary();
  }
  function parsePrimary(): Value {
    const token = peek();
    if (!token) throw new Error('Unexpected end of formula');
    if (match('number')) return parseLiteral((token as { value: string }).value);
    if (match('identifier')) {
      const raw = (token as { value: string }).value;
      const name = raw.toLowerCase();
      if (match('paren', '(')) {
        const args: Value[] = [];
        if (!match('paren', ')')) {
          do {
            args.push(parseExpression());
          } while (match('comma'));
          expect('paren', ')');
        }
        try {
          return executeFormulaFunction(name, args);
        } catch (e) {
          throw new Error(`${(e as Error).message} (function "${raw}" at position ${(token as { pos: number }).pos})`);
        }
      }
      if (name === 'true') return true;
      if (name === 'false') return false;
      throw new Error(`Unsupported formula token: ${raw} at position ${(token as { pos: number }).pos}`);
    }
    if (match('paren', '(')) {
      const value = parseExpression();
      expect('paren', ')');
      return value;
    }
    throw new Error(`Unexpected token "${token.value}" in formula at position ${token.pos}`);
  }

  const result = parseExpression();
  if (position !== tokens.length) {
    const token = tokens[position]!;
    throw new Error(`Unexpected trailing formula content "${token.value}" at position ${token.pos}`);
  }
  return renderMoney(toDecimal(result));
}
