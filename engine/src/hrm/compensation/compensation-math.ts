import { CompensationError } from "./errors.ts";

/**
 * Compensation math (HR-12): compa-ratio, guideline resolution, the
 * fixed-grammar formula evaluator, and ordinary least squares for the
 * unexplained pay gap.
 *
 * Pure: no DB, no clock, no imports beyond the error type — so the unit
 * test below is a test of the algorithm itself, not of a double. Money
 * arrives as decimal strings; ratios stay decimal strings with 10 places.
 * The OLS fit itself runs on finite numbers (rates are bounded civil
 * amounts, never NaN/Infinity — guarded at the boundary).
 */

const RATIO_SCALE = 10;

function toFiniteNumber(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new CompensationError("INVALID_INPUT", `${what} ${JSON.stringify(value)} is not a finite decimal — refuse the amount, never coerce it`);
  }
  return n;
}

/** compaRatio = rate / target, scaled to 10 decimal places. Refuses a non-positive target by name. */
export function compaRatio(rate: string, target: string): string {
  const r = toFiniteNumber(rate, "rate");
  const t = toFiniteNumber(target, "band target");
  if (!(t > 0)) {
    throw new CompensationError(
      "REFUSED",
      `band target ${target} is not positive — a compa-ratio against a zero target is undefined; fix the band before placing anyone in it`,
    );
  }
  if (!(r >= 0)) {
    throw new CompensationError(
      "REFUSED",
      `rate ${rate} is negative — a negative wage cannot sit in a band; correct the payroll-side rate first`,
    );
  }
  return (r / t).toFixed(RATIO_SCALE);
}

/** Placement of a person against their band: below, in, or above range, with the ratio. */
export function bandPlacement(
  rate: string,
  min: string,
  target: string,
  max: string,
): { compaRatio: string; placement: "below_min" | "in_range" | "above_max" } {
  const r = toFiniteNumber(rate, "rate");
  const lo = toFiniteNumber(min, "band min");
  const hi = toFiniteNumber(max, "band max");
  const ratio = compaRatio(rate, target);
  if (r < lo) return { compaRatio: ratio, placement: "below_min" };
  if (r > hi) return { compaRatio: ratio, placement: "above_max" };
  return { compaRatio: ratio, placement: "in_range" };
}

export const COMPA_QUARTILES = ["q1", "q2", "q3", "q4"] as const;
export type CompaQuartile = (typeof COMPA_QUARTILES)[number];

/** Compa-ratio quartile: q1 <0.8, q2 0.8–0.95, q3 0.95–1.1, q4 >1.1. Boundaries belong to the higher quartile. */
export function compaQuartile(ratio: string): CompaQuartile {
  const r = toFiniteNumber(ratio, "compa-ratio");
  if (r < 0.8) return "q1";
  if (r < 0.95) return "q2";
  if (r < 1.1) return "q3";
  return "q4";
}

export interface GuidelineCell {
  readonly min: number;
  readonly max: number;
}

export interface MatrixGuideline {
  readonly rows: readonly string[];
  readonly cols: readonly string[];
  readonly cells: Readonly<Record<string, Readonly<Record<string, GuidelineCell>>>>;
  readonly unratedRow?: string;
}

/**
 * Resolve the guideline percent range for one line. The rating key selects
 * the matrix row (falling back to the declared unrated row, then the first
 * row — never to a colleague's rating); the compa-ratio quartile selects
 * the column. Refuses by name when the matrix has no cell for the pair.
 */
export function resolveMatrixGuideline(
  guideline: MatrixGuideline,
  ratingKey: string | null,
  ratio: string,
): GuidelineCell {
  const rowKey =
    (ratingKey !== null && guideline.rows.includes(ratingKey) ? ratingKey : null) ??
    guideline.unratedRow ??
    guideline.rows[0];
  if (rowKey === undefined) {
    throw new CompensationError(
      "REFUSED",
      "the cycle guideline matrix has no rows — declare at least one performance bucket before opening the cycle",
    );
  }
  const colKey = compaQuartile(ratio);
  const col = guideline.cols.includes(colKey) ? colKey : guideline.cols[0];
  const cell = guideline.cells[rowKey]?.[col ?? ""];
  if (!cell || !(cell.min <= cell.max)) {
    throw new CompensationError(
      "REFUSED",
      `the cycle guideline has no usable cell for performance ${JSON.stringify(rowKey)} in quartile ${col} — complete the matrix before opening the cycle`,
    );
  }
  return { min: cell.min, max: cell.max };
}

// ---------------------------------------------------------------------------
// Fixed-grammar formula evaluator.
//
// The guideline formula is a declared expression over exactly three
// variables (rating, compa_ratio, tenure_years) with + - * / parens and
// min/max/clamp calls. There is deliberately no eval, no Function
// constructor, no property access, and no other identifier: anything else
// is a refusal naming what was found. Operator precedence is standard
// (unary minus binds tightest after calls).
// ---------------------------------------------------------------------------

const FORMULA_IDENTIFIERS = ["rating", "compa_ratio", "tenure_years"] as const;
export type FormulaIdentifier = (typeof FORMULA_IDENTIFIERS)[number];

export interface FormulaInputs {
  readonly rating: number | null;
  readonly compaRatio: number;
  readonly tenureYears: number;
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", op: ch });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i += 1;
      continue;
    }
    const num = /^[0-9]+(\.[0-9]+)?/.exec(expr.slice(i));
    if (num) {
      tokens.push({ kind: "number", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i));
    if (ident) {
      tokens.push({ kind: "ident", name: ident[0] });
      i += ident[0].length;
      continue;
    }
    throw new CompensationError(
      "REFUSED",
      `the guideline formula contains ${JSON.stringify(ch)} — only numbers, rating, compa_ratio, tenure_years, + - * /, parens and min/max/clamp are allowed; rewrite the formula instead of guessing`,
    );
  }
  return tokens;
}

class FormulaParser {
  private pos = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly inputs: FormulaInputs,
  ) {}

  parse(): number {
    const value = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new CompensationError(
        "REFUSED",
        "the guideline formula has trailing input after a complete expression — balance the parens and remove the extra text",
      );
    }
    return value;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private parseExpr(): number {
    let value = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t?.kind !== "op" || (t.op !== "+" && t.op !== "-")) return value;
      this.pos += 1;
      const rhs = this.parseTerm();
      value = t.op === "+" ? value + rhs : value - rhs;
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t?.kind !== "op" || (t.op !== "*" && t.op !== "/")) return value;
      this.pos += 1;
      const rhs = this.parseFactor();
      if (t.op === "/") {
        if (rhs === 0) {
          throw new CompensationError(
            "REFUSED",
            "the guideline formula divides by zero for this line — the formula cannot price this person; correct the formula or set the line by matrix",
          );
        }
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    }
  }

  private parseFactor(): number {
    const t = this.peek();
    if (t?.kind === "op" && t.op === "-") {
      this.pos += 1;
      return -this.parseFactor();
    }
    if (t?.kind === "number") {
      this.pos += 1;
      return t.value;
    }
    if (t?.kind === "ident") {
      return this.parseIdentOrCall();
    }
    if (t?.kind === "lparen") {
      this.pos += 1;
      const value = this.parseExpr();
      const close = this.peek();
      if (close?.kind !== "rparen") {
        throw new CompensationError(
          "REFUSED",
          "the guideline formula has an unclosed paren — balance the parens instead of guessing where it ends",
        );
      }
      this.pos += 1;
      return value;
    }
    throw new CompensationError(
      "REFUSED",
      "the guideline formula ends mid-expression — complete the operand instead of guessing it",
    );
  }

  private parseIdentOrCall(): number {
    const t = this.tokens[this.pos]!;
    if (t.kind !== "ident") throw new Error("unreachable");
    this.pos += 1;
    const next = this.peek();
    if (next?.kind === "lparen") {
      if (t.name !== "min" && t.name !== "max" && t.name !== "clamp") {
        throw new CompensationError(
          "REFUSED",
          `the guideline formula calls ${JSON.stringify(t.name)} — only min, max and clamp exist; rewrite the formula instead of guessing`,
        );
      }
      this.pos += 1;
      const args: number[] = [];
      if (this.peek()?.kind !== "rparen") {
        for (;;) {
          args.push(this.parseExpr());
          const sep = this.peek();
          if (sep?.kind === "comma") {
            this.pos += 1;
            continue;
          }
          break;
        }
      }
      const close = this.peek();
      if (close?.kind !== "rparen") {
        throw new CompensationError(
          "REFUSED",
          `the guideline formula call to ${t.name} is missing its closing paren — balance the parens instead of guessing`,
        );
      }
      this.pos += 1;
      if (t.name === "clamp") {
        if (args.length !== 3) {
          throw new CompensationError(
            "REFUSED",
            `clamp takes exactly three arguments (value, low, high), got ${args.length} — fix the call instead of guessing the bounds`,
          );
        }
        return Math.min(Math.max(args[0]!, args[1]!), args[2]!);
      }
      if (args.length === 0) {
        throw new CompensationError(
          "REFUSED",
          `${t.name} needs at least one argument — supply the values instead of guessing them`,
        );
      }
      return t.name === "min" ? Math.min(...args) : Math.max(...args);
    }
    if (!(FORMULA_IDENTIFIERS as readonly string[]).includes(t.name)) {
      throw new CompensationError(
        "REFUSED",
        `the guideline formula names ${JSON.stringify(t.name)} — only rating, compa_ratio and tenure_years exist; declare the formula over those instead of guessing`,
      );
    }
    if (t.name === "rating") {
      const rating = this.inputs.rating;
      if (rating === null) {
        throw new CompensationError(
          "REFUSED",
          "the guideline formula needs a rating but this line has no shared review — share a review for the cycle window or set the line by matrix",
        );
      }
      return rating;
    }
    if (t.name === "compa_ratio") return this.inputs.compaRatio;
    return this.inputs.tenureYears;
  }
}

/**
 * Evaluate a declared guideline formula. Returns the percent (a number
 * like 3.5, not a fraction). Refuses anything outside the fixed grammar
 * by name — never eval, never a silent zero.
 */
export function evaluateFormula(expr: string, inputs: FormulaInputs): number {
  if (expr.trim().length === 0) {
    throw new CompensationError(
      "REFUSED",
      "the guideline formula is empty — declare an expression over rating, compa_ratio and tenure_years before opening the cycle",
    );
  }
  if (!Number.isFinite(inputs.compaRatio) || !Number.isFinite(inputs.tenureYears)) {
    throw new CompensationError(
      "REFUSED",
      "the guideline formula inputs are not finite — resolve the compa-ratio and tenure before evaluating",
    );
  }
  const value = new FormulaParser(tokenize(expr), inputs).parse();
  if (!Number.isFinite(value)) {
    throw new CompensationError(
      "REFUSED",
      "the guideline formula evaluates to a non-finite percent — the formula cannot price this line; correct it or set the line by matrix",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Ordinary least squares with an intercept.
//
// Fits y = b0 + b1*x1 + ... + bk*xk by the normal equations with partial
// pivoting. Used for the "unexplained" pay gap: the comparison-group
// indicator is one column among tenure, level rank, hours basis and
// employer subsidiary, so its coefficient is the gap nothing else
// explains. No dependency — the implementation is ~40 lines and pinned by
// a hand-computed fixture in the unit test.
// ---------------------------------------------------------------------------

export interface OlsFit {
  readonly coefficients: readonly number[];
  readonly rSquared: number;
}

/** Solve a square linear system by Gaussian elimination with partial pivoting. Refuses a singular system by name. */
export function solveLinearSystem(a: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = b.length;
  if (n === 0 || a.length !== n || a.some((row) => row.length !== n)) {
    throw new CompensationError(
      "REFUSED",
      "the pay-gap regression needs a square system — the category has fewer usable rows than fitted columns, so no unexplained gap can be computed for it",
    );
  }
  const m: number[][] = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) {
      throw new CompensationError(
        "REFUSED",
        "the pay-gap regression is singular for this category — two fitted columns move together (e.g. every record shares one subsidiary), so the unexplained gap cannot be separated; widen the category instead of reporting a number",
      );
    }
    const tmp = m[col]!;
    m[col] = m[pivot]!;
    m[pivot] = tmp;
    for (let row = col + 1; row < n; row += 1) {
      const factor = m[row]![col]! / m[col]![col]!;
      for (let k = col; k <= n; k += 1) m[row]![k]! -= factor * m[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row]![n]!;
    for (let k = row + 1; k < n; k += 1) sum -= m[row]![k]! * x[k]!;
    x[row] = sum / m[row]![row]!;
  }
  return x;
}

/**
 * Fit y on columns (an intercept is prepended). Each observation is
 * {y, x}. Returns coefficients [intercept, ...slopes] and R². Refuses
 * fewer observations than columns, and any non-finite input, by name.
 */
export function ordinaryLeastSquares(observations: readonly { y: number; x: readonly number[] }[]): OlsFit {
  if (observations.length === 0) {
    throw new CompensationError(
      "REFUSED",
      "the pay-gap regression has no rows — the category is empty, so there is no gap to explain",
    );
  }
  const k = observations[0]!.x.length;
  for (const [i, o] of observations.entries()) {
    if (!Number.isFinite(o.y) || o.x.length !== k || o.x.some((v) => !Number.isFinite(v))) {
      throw new CompensationError(
        "REFUSED",
        `the pay-gap regression row ${i} is not finite — drop unpriced records before fitting instead of fitting around them`,
      );
    }
  }
  if (observations.length < k + 1) {
    throw new CompensationError(
      "REFUSED",
      `the pay-gap regression has ${observations.length} rows for ${k + 1} fitted columns — the category is too thin to separate an unexplained gap; widen it instead of reporting a number`,
    );
  }
  const dim = k + 1;
  const xtx: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  const xty = new Array<number>(dim).fill(0);
  for (const o of observations) {
    const row = [1, ...o.x];
    for (let i = 0; i < dim; i += 1) {
      xty[i]! += row[i]! * o.y;
      for (let j = 0; j < dim; j += 1) xtx[i]![j]! += row[i]! * row[j]!;
    }
  }
  const coefficients = solveLinearSystem(xtx, xty);
  const mean = observations.reduce((s, o) => s + o.y, 0) / observations.length;
  let ssTot = 0;
  let ssRes = 0;
  for (const o of observations) {
    const fitted = coefficients.reduce((s, c, i) => s + c! * (i === 0 ? 1 : o.x[i - 1]!), 0);
    ssTot += (o.y - mean) ** 2;
    ssRes += (o.y - fitted) ** 2;
  }
  return { coefficients, rSquared: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

/**
 * The unexplained gap: OLS on log-rate over the group indicator plus
 * tenure, level rank, hours basis and employer subsidiary. Columns with
 * no variance (a single-level category always has constant rank; a
 * single-subsidiary org a constant subsidiary) are dropped before
 * fitting — fitting them would singularise the system and refuse a gap
 * the data does explain. The group indicator is always fitted, so a
 * category varying in nothing else still reports the raw log gap,
 * named method 'group_only' instead of 'ols_log_rate'.
 */
export function fitUnexplainedGap(
  members: ReadonlyArray<{
    groupIsA: boolean;
    tenureYears: number;
    levelRank: number;
    hoursBasis: number;
    subsidiaryIdx: number;
    logRate: number;
  }>,
): { unexplainedGapPct: number | null; method: string } {
  const controls: ReadonlyArray<{ name: string; values: readonly number[] }> = [
    { name: "tenure", values: members.map((m) => m.tenureYears) },
    { name: "rank", values: members.map((m) => m.levelRank) },
    { name: "hours", values: members.map((m) => m.hoursBasis) },
    { name: "subsidiary", values: members.map((m) => m.subsidiaryIdx) },
  ];
  const varied = controls.filter((c) => Math.max(...c.values) - Math.min(...c.values) > 1e-9);
  try {
    const fit = ordinaryLeastSquares(
      members.map((m, idx) => ({
        y: m.logRate,
        x: [m.groupIsA ? 1 : 0, ...varied.map((c) => c.values[idx]!)],
      })),
    );
    return {
      unexplainedGapPct: (Math.exp(fit.coefficients[1]!) - 1) * 100,
      method: varied.length === 0 ? "group_only" : "ols_log_rate",
    };
  } catch {
    return { unexplainedGapPct: null, method: "insufficient_data" };
  }
}

/** Mean and median of finite numbers. Refuses the empty set by name. */
export function meanAndMedian(values: readonly number[], what: string): { mean: number; median: number } {
  if (values.length === 0) {
    throw new CompensationError("REFUSED", `${what} has no records — there is no gap to measure`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { mean, median };
}
