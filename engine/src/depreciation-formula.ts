/**
 * Depreciation formula engine — the flexible core that makes depreciation
 * METHODS DATA rather than a hardcoded switch. A method is an expression over a
 * fixed variable set (modelled 1:1 on NetSuite FAM's formula methods), evaluated
 * once per period against a per-period context. One evaluator subsumes
 * straight-line, declining-balance (any factor), sum-of-years-digits,
 * units-of-production, fixed-percent, rate-table (MACRS) and arbitrary
 * user-defined methods.
 *
 * Grammar (NetSuite-compatible):
 *   expr    := max
 *   max     := add ( '~' add )*                 // '~' = take the greater operand
 *   add     := mul ( ('+'|'-') mul )*
 *   mul     := pow ( ('*'|'/') pow )*
 *   pow     := unary ( '^' pow )?               // right-associative
 *   unary   := '-' unary | primary
 *   primary := number | VAR | '(' expr ')'
 *            | 'IF' cond 'THEN' expr 'ELSE' expr 'ENDIF'
 *            | 'ROUND' '(' expr ( ',' number )? ')'
 *   cond    := expr ('<='|'<'|'=='|'!='|'>='|'>') expr
 *
 * Variables (all numbers): OC original cost, CC current cost (write-downs
 * reduce it), NB net book value, RV residual/salvage, AL asset life in periods,
 * CP current 1-based period, TD total depreciation to date, LD last period's
 * charge, CU current-period usage, LU lifetime usage, DH days held this period,
 * DP days in the period, FY days in the fiscal year, PB prior fiscal-year-end
 * NBV, and R1..Rn rate-table entries.
 *
 * Injection-safe by construction: only whitelisted tokens parse; there is no
 * `eval`/`Function`. Amounts are plain numbers here; the scheduler rounds each
 * period to the ledger's 4dp.
 */

export interface DepContext {
  OC: number;
  CC: number;
  NB: number;
  RV: number;
  AL: number;
  CP: number;
  TD: number;
  LD: number;
  CU: number;
  LU: number;
  DH: number;
  DP: number;
  FY: number;
  PB: number;
  /** Rate-table entries referenced as R1..Rn (1-based in the formula). */
  R?: number[];
}

const SCALAR_VARS = new Set([
  "OC", "CC", "NB", "RV", "AL", "CP", "TD", "LD", "CU", "LU", "DH", "DP", "FY", "PB",
]);
const KEYWORDS = new Set(["IF", "THEN", "ELSE", "ENDIF", "ROUND"]);

export class DepreciationFormulaError extends Error {
  readonly name = "DepreciationFormulaError";
}

// --- tokenizer --------------------------------------------------------------

type Tok =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "op"; v: string };

const OP_RE = /^(<=|>=|==|!=|[-+*/^~()<>,])/;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+/.exec(src.slice(i));
      if (!m) throw new DepreciationFormulaError(`bad number at ${i}`);
      toks.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z][A-Za-z0-9]*/.exec(src.slice(i))!;
      toks.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const om = OP_RE.exec(src.slice(i));
    if (!om) throw new DepreciationFormulaError(`unexpected "${c}" at ${i}`);
    toks.push({ k: "op", v: om[0] });
    i += om[0].length;
  }
  return toks;
}

// --- parser (produces an AST of closures over DepContext) -------------------

type Node = (ctx: DepContext) => number;

function resolveVar(name: string): Node {
  if (SCALAR_VARS.has(name)) return (ctx) => (ctx as unknown as Record<string, number>)[name] ?? 0;
  const rm = /^R(\d+)$/.exec(name);
  if (rm) {
    const idx = Number(rm[1]) - 1;
    return (ctx) => ctx.R?.[idx] ?? 0;
  }
  throw new DepreciationFormulaError(`unknown variable "${name}"`);
}

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[], private readonly src: string) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }
  private eatOp(v: string): void {
    const t = this.next();
    if (!t || t.k !== "op" || t.v !== v) throw new DepreciationFormulaError(`expected "${v}" in "${this.src}"`);
  }
  private eatKw(v: string): void {
    const t = this.next();
    if (!t || t.k !== "id" || t.v.toUpperCase() !== v) throw new DepreciationFormulaError(`expected ${v} in "${this.src}"`);
  }

  parse(): Node {
    const n = this.expr();
    if (this.pos !== this.toks.length) throw new DepreciationFormulaError(`trailing tokens in "${this.src}"`);
    return n;
  }

  private expr(): Node {
    let l = this.add();
    while (this.peek()?.k === "op" && this.peek()!.v === "~") {
      this.next();
      const r = this.add();
      const a = l, b = r;
      l = (ctx) => Math.max(a(ctx), b(ctx));
    }
    return l;
  }
  private add(): Node {
    let l = this.mul();
    while (this.peek()?.k === "op" && (this.peek()!.v === "+" || this.peek()!.v === "-")) {
      const op = this.next()!.v;
      const r = this.mul();
      const a = l, b = r;
      l = op === "+" ? (ctx) => a(ctx) + b(ctx) : (ctx) => a(ctx) - b(ctx);
    }
    return l;
  }
  private mul(): Node {
    let l = this.pow();
    while (this.peek()?.k === "op" && (this.peek()!.v === "*" || this.peek()!.v === "/")) {
      const op = this.next()!.v;
      const r = this.pow();
      const a = l, b = r;
      l = op === "*" ? (ctx) => a(ctx) * b(ctx) : (ctx) => {
        const d = b(ctx);
        return d === 0 ? 0 : a(ctx) / d;
      };
    }
    return l;
  }
  private pow(): Node {
    const l = this.unary();
    if (this.peek()?.k === "op" && this.peek()!.v === "^") {
      this.next();
      const r = this.pow(); // right-assoc
      return (ctx) => Math.pow(l(ctx), r(ctx));
    }
    return l;
  }
  private unary(): Node {
    if (this.peek()?.k === "op" && this.peek()!.v === "-") {
      this.next();
      const e = this.unary();
      return (ctx) => -e(ctx);
    }
    return this.primary();
  }
  private primary(): Node {
    const t = this.next();
    if (!t) throw new DepreciationFormulaError(`unexpected end of "${this.src}"`);
    if (t.k === "num") {
      const v = t.v;
      return () => v;
    }
    if (t.k === "op" && t.v === "(") {
      const e = this.expr();
      this.eatOp(")");
      return e;
    }
    if (t.k === "id") {
      const up = t.v.toUpperCase();
      if (up === "IF") return this.ifExpr();
      if (up === "ROUND") return this.roundExpr();
      if (KEYWORDS.has(up)) throw new DepreciationFormulaError(`unexpected ${t.v} in "${this.src}"`);
      return resolveVar(t.v);
    }
    throw new DepreciationFormulaError(`unexpected "${t.v}" in "${this.src}"`);
  }
  private ifExpr(): Node {
    const cond = this.condition();
    this.eatKw("THEN");
    const thenN = this.expr();
    this.eatKw("ELSE");
    const elseN = this.expr();
    this.eatKw("ENDIF");
    return (ctx) => (cond(ctx) ? thenN(ctx) : elseN(ctx));
  }
  private roundExpr(): Node {
    this.eatOp("(");
    const e = this.expr();
    let digits = 2;
    if (this.peek()?.k === "op" && this.peek()!.v === ",") {
      this.next();
      const d = this.next();
      if (!d || d.k !== "num") throw new DepreciationFormulaError(`ROUND digits must be a number in "${this.src}"`);
      digits = Math.trunc(d.v);
    }
    this.eatOp(")");
    const f = Math.pow(10, digits);
    return (ctx) => Math.round(e(ctx) * f) / f;
  }
  private condition(): (ctx: DepContext) => boolean {
    const l = this.expr();
    const opTok = this.next();
    if (!opTok || opTok.k !== "op" || !["<=", "<", "==", "!=", ">=", ">"].includes(opTok.v)) {
      throw new DepreciationFormulaError(`expected a comparison in "${this.src}"`);
    }
    const r = this.expr();
    const op = opTok.v;
    return (ctx) => {
      const a = l(ctx), b = r(ctx);
      switch (op) {
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

/** Compile a formula into a reusable evaluator (cached by source). */
export function compileFormula(src: string): (ctx: DepContext) => number {
  const hit = cache.get(src);
  if (hit) return hit;
  const node = new Parser(tokenize(src), src).parse();
  cache.set(src, node);
  return node;
}

/** Evaluate a formula against a context (compiles + caches on first use). */
export function evalDepFormula(src: string, ctx: DepContext): number {
  return compileFormula(src)(ctx);
}

// --- formula-driven schedule -----------------------------------------------

export interface FormulaScheduleInput {
  /** Acquisition cost (decimal string). */
  cost: string;
  /** Residual / salvage value (decimal string). */
  salvage: string;
  /** Useful life in periods (> 0). */
  lifePeriods: number;
  /** Method expression over the DepContext variable set. */
  formula: string;
  /** fully_depreciate: last period plugs to residual (default). retain_balance:
   *  charge only what the formula yields (e.g. units-of-production). */
  endOfLife?: "fully_depreciate" | "retain_balance";
  /** Per-period usage for units-of-production (CU). */
  usage?: number[];
  /** Lifetime usage (LU); defaults to the sum of `usage`. */
  lifetimeUsage?: number;
  /** Rate-table entries referenced as R1..Rn. */
  rateTable?: number[];
  /** Convention: fraction of the FIRST period taken (1 = full month, 0.5 =
   *  mid-month / half-year). When < 1 the schedule extends by one period so the
   *  deferred fraction depreciates at the end; total lifetime is unchanged. */
  firstPeriodFraction?: number;
}

export interface FormulaScheduleLine {
  sequence: number;
  /** Depreciation charged this period (decimal string, 4dp, ≥ 0). */
  planned: string;
  /** Accumulated depreciation through this period (4dp). */
  accumulated: string;
  /** Net book value at period end = cost − accumulated (4dp). */
  netBookValue: string;
}

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;
const fixed4 = (n: number) => round4(n).toFixed(4);

/**
 * Build a per-period depreciation plan by evaluating a formula method each
 * period. Charges are clamped to `[0, NB − residual]` so no method drives book
 * value below salvage or negative; `fully_depreciate` plugs the final period so
 * total lifetime depreciation is exactly `cost − salvage`.
 */
export function computeScheduleByFormula(input: FormulaScheduleInput): FormulaScheduleLine[] {
  const life = Math.max(1, Math.trunc(input.lifePeriods));
  const cost = Number(input.cost);
  const salvage = Number(input.salvage);
  const depreciableBase = round4(cost - salvage);
  if (depreciableBase <= 0) return [];

  const evalFn = compileFormula(input.formula);
  const endOfLife = input.endOfLife ?? "fully_depreciate";
  const lu = input.lifetimeUsage ?? (input.usage ? input.usage.reduce((a, b) => a + b, 0) : 0);

  const fpf = input.firstPeriodFraction ?? 1;
  // A part-period convention defers a fraction of period 1, so the schedule
  // needs one extra period at the end to absorb it (only meaningful when the
  // final period plugs).
  const extend = fpf < 1 && endOfLife === "fully_depreciate" ? 1 : 0;
  const totalPeriods = life + extend;

  const lines: FormulaScheduleLine[] = [];
  let accumulated = 0;
  let last = 0;
  for (let cp = 1; cp <= totalPeriods; cp++) {
    const nb = round4(cost - accumulated);
    const remaining = round4(nb - salvage); // depreciable value left above salvage
    let charge: number;
    if (endOfLife === "fully_depreciate" && cp === totalPeriods) {
      charge = remaining; // plug so the schedule totals exactly
    } else {
      const ctx: DepContext = {
        OC: cost, CC: cost, NB: nb, RV: salvage, AL: life, CP: cp,
        TD: accumulated, LD: last, CU: input.usage?.[cp - 1] ?? 0, LU: lu,
        DH: 1, DP: 1, FY: 12, PB: 0, R: input.rateTable,
      };
      charge = round4(evalFn(ctx));
      if (!Number.isFinite(charge) || charge < 0) charge = 0;
      if (cp === 1 && fpf < 1) charge = round4(charge * fpf); // convention proration
      if (charge > remaining) charge = remaining;
    }
    accumulated = round4(accumulated + charge);
    last = charge;
    lines.push({
      sequence: cp - 1,
      planned: fixed4(charge),
      accumulated: fixed4(accumulated),
      netBookValue: fixed4(cost - accumulated),
    });
  }
  return lines;
}

/** Canonical built-in methods expressed in the formula grammar. `~` gives the
 *  declining-balance→straight-line crossover so DB methods finish cleanly. */
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
