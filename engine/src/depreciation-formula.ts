import { fromUnits, roundDiv, toUnits } from "./money.ts";

/**
 * Exact fixed-point depreciation formula engine. Formula values use 12 decimal
 * places internally and schedule charges are rounded once to ledger precision
 * (numeric(19,4)). No monetary value crosses JavaScript's binary-float path.
 */

export type DecimalInput = string | number;

export interface DepContext {
  OC: DecimalInput;
  CC: DecimalInput;
  NB: DecimalInput;
  RV: DecimalInput;
  AL: DecimalInput;
  CP: DecimalInput;
  TD: DecimalInput;
  LD: DecimalInput;
  CU: DecimalInput;
  LU: DecimalInput;
  DH: DecimalInput;
  DP: DecimalInput;
  FY: DecimalInput;
  PB: DecimalInput;
  R?: DecimalInput[];
}

const PRECISION = 12;
const EXACT_SCALE = 10n ** BigInt(PRECISION);
const MONEY_TO_EXACT = 10n ** BigInt(PRECISION - 4);

export class DepreciationFormulaError extends Error {
  readonly name = "DepreciationFormulaError";
}

function exactUnits(value: DecimalInput): bigint {
  let raw = String(value).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
    throw new DepreciationFormulaError(`not a decimal number: "${value}"`);
  }
  const negative = raw.startsWith("-");
  raw = raw.replace(/^[-+]/, "");
  let exponent = 0;
  const exponentMatch = raw.match(/[eE]([-+]?\d+)$/);
  if (exponentMatch) {
    exponent = Number.parseInt(exponentMatch[1]!, 10);
    raw = raw.slice(0, exponentMatch.index);
  }
  let [whole = "0", fraction = ""] = raw.split(".");
  const digits = `${whole}${fraction}` || "0";
  const decimalPosition = whole.length + exponent;
  let normalizedWhole: string;
  let normalizedFraction: string;
  if (decimalPosition <= 0) {
    normalizedWhole = "0";
    normalizedFraction = `${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    normalizedWhole = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
    normalizedFraction = "";
  } else {
    normalizedWhole = digits.slice(0, decimalPosition);
    normalizedFraction = digits.slice(decimalPosition);
  }
  const kept = normalizedFraction.slice(0, PRECISION).padEnd(PRECISION, "0");
  const discarded = normalizedFraction.slice(PRECISION);
  let units = BigInt(normalizedWhole || "0") * EXACT_SCALE + BigInt(kept || "0");
  if (discarded.length > 0 && discarded[0]! >= "5") units += 1n;
  return negative ? -units : units;
}

function exactString(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / EXACT_SCALE;
  const fraction = (absolute % EXACT_SCALE).toString().padStart(PRECISION, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Exact decimal ratio for configurable rates, retaining formula precision. */
export function exactRatio(numerator: DecimalInput, denominator: DecimalInput): string {
  const divisor = exactUnits(denominator);
  if (divisor === 0n) throw new DepreciationFormulaError("ratio denominator cannot be zero");
  return exactString(divExact(exactUnits(numerator), divisor));
}

const mulExact = (a: bigint, b: bigint): bigint => roundDiv(a * b, EXACT_SCALE);
const divExact = (a: bigint, b: bigint): bigint => {
  if (b === 0n) throw new DepreciationFormulaError("formula denominator cannot be zero");
  return roundDiv(a * EXACT_SCALE, b < 0n ? -b : b) * (b < 0n ? -1n : 1n);
};

function powExact(base: bigint, exponent: bigint): bigint {
  if (exponent % EXACT_SCALE !== 0n) {
    throw new DepreciationFormulaError("formula exponent must be an integer");
  }
  let power = exponent / EXACT_SCALE;
  if (power > 1_000n || power < -1_000n) throw new DepreciationFormulaError("formula exponent is out of range");
  const inverse = power < 0n;
  if (inverse) power = -power;
  let result = EXACT_SCALE;
  let factor = base;
  while (power > 0n) {
    if (power & 1n) result = mulExact(result, factor);
    power >>= 1n;
    if (power > 0n) factor = mulExact(factor, factor);
  }
  return inverse ? divExact(EXACT_SCALE, result) : result;
}

type Tok =
  | { k: "num"; v: string }
  | { k: "id"; v: string }
  | { k: "op"; v: string };

const OP_RE = /^(<=|>=|==|!=|[-+*/^~()<>,])/;
const SCALAR_VARS = new Set(["OC", "CC", "NB", "RV", "AL", "CP", "TD", "LD", "CU", "LU", "DH", "DP", "FY", "PB"]);
const KEYWORDS = new Set(["IF", "THEN", "ELSE", "ENDIF", "ROUND"]);

function tokenize(src: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const char = src[i]!;
    if (/\s/.test(char)) { i++; continue; }
    if (/[0-9.]/.test(char)) {
      const match = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(src.slice(i));
      if (!match) throw new DepreciationFormulaError(`bad number at ${i}`);
      tokens.push({ k: "num", v: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      const match = /^[A-Za-z][A-Za-z0-9]*/.exec(src.slice(i))!;
      tokens.push({ k: "id", v: match[0] });
      i += match[0].length;
      continue;
    }
    const match = OP_RE.exec(src.slice(i));
    if (!match) throw new DepreciationFormulaError(`unexpected "${char}" at ${i}`);
    tokens.push({ k: "op", v: match[0] });
    i += match[0].length;
  }
  return tokens;
}

type Node = (context: DepContext) => bigint;

function resolveVar(name: string): Node {
  if (SCALAR_VARS.has(name)) {
    return (context) => exactUnits((context as unknown as Record<string, DecimalInput>)[name] ?? "0");
  }
  const rate = /^R(\d+)$/.exec(name);
  if (rate) {
    const index = Number.parseInt(rate[1]!, 10) - 1;
    return (context) => exactUnits(context.R?.[index] ?? "0");
  }
  throw new DepreciationFormulaError(`unknown variable "${name}"`);
}

class Parser {
  private position = 0;
  constructor(private readonly tokens: Tok[], private readonly source: string) {}

  private peek(): Tok | undefined { return this.tokens[this.position]; }
  private next(): Tok | undefined { return this.tokens[this.position++]; }
  private eatOp(value: string): void {
    const token = this.next();
    if (!token || token.k !== "op" || token.v !== value) throw new DepreciationFormulaError(`expected "${value}" in "${this.source}"`);
  }
  private eatKeyword(value: string): void {
    const token = this.next();
    if (!token || token.k !== "id" || token.v.toUpperCase() !== value) throw new DepreciationFormulaError(`expected ${value} in "${this.source}"`);
  }
  parse(): Node {
    const node = this.expression();
    if (this.position !== this.tokens.length) throw new DepreciationFormulaError(`trailing tokens in "${this.source}"`);
    return node;
  }
  private expression(): Node {
    let left = this.add();
    while (this.peek()?.k === "op" && this.peek()!.v === "~") {
      this.next();
      const right = this.add();
      const prior = left;
      left = (context) => {
        const a = prior(context), b = right(context);
        return a > b ? a : b;
      };
    }
    return left;
  }
  private add(): Node {
    let left = this.multiply();
    while (this.peek()?.k === "op" && (this.peek()!.v === "+" || this.peek()!.v === "-")) {
      const operation = this.next()!.v;
      const right = this.multiply();
      const prior = left;
      left = operation === "+" ? (context) => prior(context) + right(context) : (context) => prior(context) - right(context);
    }
    return left;
  }
  private multiply(): Node {
    let left = this.power();
    while (this.peek()?.k === "op" && (this.peek()!.v === "*" || this.peek()!.v === "/")) {
      const operation = this.next()!.v;
      const right = this.power();
      const prior = left;
      left = operation === "*" ? (context) => mulExact(prior(context), right(context)) : (context) => divExact(prior(context), right(context));
    }
    return left;
  }
  private power(): Node {
    const left = this.unary();
    if (this.peek()?.k === "op" && this.peek()!.v === "^") {
      this.next();
      const right = this.power();
      return (context) => powExact(left(context), right(context));
    }
    return left;
  }
  private unary(): Node {
    if (this.peek()?.k === "op" && this.peek()!.v === "-") {
      this.next();
      const node = this.unary();
      return (context) => -node(context);
    }
    return this.primary();
  }
  private primary(): Node {
    const token = this.next();
    if (!token) throw new DepreciationFormulaError(`unexpected end of "${this.source}"`);
    if (token.k === "num") {
      const value = exactUnits(token.v);
      return () => value;
    }
    if (token.k === "op" && token.v === "(") {
      const node = this.expression();
      this.eatOp(")");
      return node;
    }
    if (token.k === "id") {
      const keyword = token.v.toUpperCase();
      if (keyword === "IF") return this.ifExpression();
      if (keyword === "ROUND") return this.roundExpression();
      if (KEYWORDS.has(keyword)) throw new DepreciationFormulaError(`unexpected ${token.v} in "${this.source}"`);
      return resolveVar(token.v);
    }
    throw new DepreciationFormulaError(`unexpected "${token.v}" in "${this.source}"`);
  }
  private ifExpression(): Node {
    const condition = this.condition();
    this.eatKeyword("THEN");
    const whenTrue = this.expression();
    this.eatKeyword("ELSE");
    const whenFalse = this.expression();
    this.eatKeyword("ENDIF");
    return (context) => condition(context) ? whenTrue(context) : whenFalse(context);
  }
  private roundExpression(): Node {
    this.eatOp("(");
    const node = this.expression();
    let digits = 2;
    if (this.peek()?.k === "op" && this.peek()!.v === ",") {
      this.next();
      const token = this.next();
      if (!token || token.k !== "num" || !/^\d+$/.test(token.v)) throw new DepreciationFormulaError(`ROUND digits must be an integer in "${this.source}"`);
      digits = Number.parseInt(token.v, 10);
    }
    this.eatOp(")");
    if (digits < 0 || digits > PRECISION) throw new DepreciationFormulaError(`ROUND digits must be 0 through ${PRECISION}`);
    const quantum = 10n ** BigInt(PRECISION - digits);
    return (context) => roundDiv(node(context), quantum) * quantum;
  }
  private condition(): (context: DepContext) => boolean {
    const left = this.expression();
    const operator = this.next();
    if (!operator || operator.k !== "op" || !["<=", "<", "==", "!=", ">=", ">"].includes(operator.v)) {
      throw new DepreciationFormulaError(`expected a comparison in "${this.source}"`);
    }
    const right = this.expression();
    return (context) => {
      const a = left(context), b = right(context);
      switch (operator.v) {
        case "<=": return a <= b;
        case "<": return a < b;
        case "==": return a === b;
        case "!=": return a !== b;
        case ">=": return a >= b;
        default: return a > b;
      }
    };
  }
}

const cache = new Map<string, Node>();

function compileExactFormula(source: string): Node {
  const cached = cache.get(source);
  if (cached) return cached;
  const node = new Parser(tokenize(source), source).parse();
  cache.set(source, node);
  return node;
}

/** Compile a formula into an exact decimal-string evaluator. */
export function compileFormula(source: string): (context: DepContext) => string {
  const exact = compileExactFormula(source);
  return (context) => exactString(exact(context));
}

export function evalDepFormula(source: string, context: DepContext): string {
  return compileFormula(source)(context);
}

export interface FormulaScheduleInput {
  cost: string;
  salvage: string;
  lifePeriods: number;
  formula: string;
  endOfLife?: "fully_depreciate" | "retain_balance";
  usage?: DecimalInput[];
  lifetimeUsage?: DecimalInput;
  rateTable?: DecimalInput[];
  firstPeriodFraction?: DecimalInput;
  /**
   * How many LEADING periods `firstPeriodFraction` applies to. Default 1.
   *
   * A first-period convention and a first-YEAR convention are different animals
   * and this engine runs on periods, not years. Mid-month reduces one month, so
   * it leaves this at 1. The half-year rule reduces the whole first YEAR — with
   * monthly periods that is the first 12, each at half charge — so it passes 12.
   * Treating half-year as "half of one month" made year one ~11.5 months of
   * expense instead of six.
   */
  firstFractionPeriods?: number;
}

export interface FormulaScheduleLine {
  sequence: number;
  planned: string;
  accumulated: string;
  netBookValue: string;
}

export function computeScheduleByFormula(input: FormulaScheduleInput): FormulaScheduleLine[] {
  const life = Math.max(1, Math.trunc(input.lifePeriods));
  const cost = toUnits(input.cost);
  const salvage = toUnits(input.salvage);
  const depreciableBase = cost - salvage;
  if (depreciableBase <= 0n) return [];
  const evaluate = compileExactFormula(input.formula);
  const endOfLife = input.endOfLife ?? "fully_depreciate";
  const lifetimeUsage = input.lifetimeUsage !== undefined
    ? exactUnits(input.lifetimeUsage)
    : (input.usage ?? []).reduce((total, usage) => total + exactUnits(usage), 0n);
  const firstPeriodFraction = exactUnits(input.firstPeriodFraction ?? "1");
  if (firstPeriodFraction < 0n || firstPeriodFraction > EXACT_SCALE) {
    throw new DepreciationFormulaError("first-period fraction must be between zero and one");
  }
  const fractionPeriods = Math.max(1, Math.trunc(input.firstFractionPeriods ?? 1));
  // The charge withheld from the reduced periods has to land somewhere, so the
  // schedule grows by exactly the periods'-worth that was held back: one month
  // for mid-month, six for a half-year rule on monthly periods. Without this the
  // whole deferred amount was dumped into a single final period.
  const withheld = Number(EXACT_SCALE - firstPeriodFraction) / Number(EXACT_SCALE);
  const extension = firstPeriodFraction < EXACT_SCALE && endOfLife === "fully_depreciate"
    ? Math.max(1, Math.round(fractionPeriods * withheld))
    : 0;
  const totalPeriods = life + extension;
  const lines: FormulaScheduleLine[] = [];
  let accumulated = 0n;
  let last = 0n;

  for (let currentPeriod = 1; currentPeriod <= totalPeriods; currentPeriod++) {
    const netBookValue = cost - accumulated;
    const remaining = netBookValue - salvage;
    let charge: bigint;
    if (endOfLife === "fully_depreciate" && currentPeriod === totalPeriods) {
      charge = remaining;
    } else if (currentPeriod > life) {
      // Tail periods created by the extension. The formulas are written in terms
      // of the nominal life — `straight_line_remaining` and the declining-balance
      // crossovers all divide by (AL − CP + 1), which is zero or negative once CP
      // passes AL — so evaluating them here is undefined, not merely inaccurate.
      // Spread what is left evenly instead, which is what a crossover tail is.
      charge = roundDiv(remaining, BigInt(totalPeriods - currentPeriod + 1));
    } else {
      const context: DepContext = {
        OC: fromUnits(cost), CC: fromUnits(cost), NB: fromUnits(netBookValue), RV: fromUnits(salvage),
        AL: String(life), CP: String(currentPeriod), TD: fromUnits(accumulated), LD: fromUnits(last),
        CU: input.usage?.[currentPeriod - 1] ?? "0", LU: exactString(lifetimeUsage),
        DH: "1", DP: "1", FY: "12", PB: "0", R: input.rateTable,
      };
      let evaluated = evaluate(context);
      if (currentPeriod <= fractionPeriods && firstPeriodFraction < EXACT_SCALE) {
        evaluated = mulExact(evaluated, firstPeriodFraction);
      }
      charge = roundDiv(evaluated, MONEY_TO_EXACT);
      if (charge < 0n) charge = 0n;
      if (charge > remaining) charge = remaining;
    }
    accumulated += charge;
    last = charge;
    lines.push({
      sequence: currentPeriod - 1,
      planned: fromUnits(charge),
      accumulated: fromUnits(accumulated),
      netBookValue: fromUnits(cost - accumulated),
    });
  }
  return lines;
}

export const BUILTIN_FORMULAS = {
  straight_line: "(OC-RV)/AL",
  straight_line_remaining: "(NB-RV)/(AL-CP+1)",
  declining_150: "(NB-RV)*(1.5/AL)~(NB-RV)/(AL-CP+1)",
  double_declining: "(NB-RV)*(2/AL)~(NB-RV)/(AL-CP+1)",
  declining_250: "(NB-RV)*(2.5/AL)~(NB-RV)/(AL-CP+1)",
  sum_of_years_digits: "(OC-RV)*(AL-CP+1)/(AL*(AL+1)/2)",
  units_of_production: "(OC-RV)*CU/LU",
  zero: "0",
} as const;
