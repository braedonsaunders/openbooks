// Typed JSON-tree evaluators for form field logic and formulas.
//
// This is the single implementation of the form condition/formula language — the designer
// preview, the filler, and the server-side submit validation all evaluate
// rules through it so visibility decisions never diverge.
//
//   - `evaluateLogicRule(rule, ctx)` — evaluates a LogicRule against the
//     EvalContext (flat values + repeating-section rows).
//   - `evaluateFormulaTree(expr, ctx)` — walks a typed FormulaExpression tree.
//     Designer-built formula fields store this on `field.formula`.
//   - `resolveDefaultValue(expr, ctx)` — produces an initial value for a field
//     from a typed DefaultValueExpression.
//
// All evaluators are pure functions over a typed expression tree: no React,
// no DB, and deliberately NO eval()/new Function() — untrusted designer input
// can never reach a JavaScript runtime.

import { parseExactDecimalParts } from './decimals'
import type { DefaultValueExpression, FormulaExpression, LogicRule } from './schema'

/**
 * A formula operand that cannot be evaluated to a number: garbage input,
 * divide-by-zero, or a non-finite intermediate. Thrown — never coerced to 0
 * — so a broken formula persists as a blank field (see withComputedFormulas)
 * instead of a real-looking amount. The message names the cause.
 */
export class FormulaEvaluationError extends Error {}

export type FieldValueMap = Record<string, unknown>

/** Per-row map keyed by section id → array of row value maps. */
export type RowMap = Record<string, Array<FieldValueMap>>

/**
 * Evaluation context shared by logic + formula evaluators.
 *
 * `values` — flat top-level field values (non-repeating sections).
 * `rows`   — per-section repeating-row arrays: rows[sectionId][rowIndex][fieldKey].
 * `requestContext` — used by `resolveDefaultValue` for `today` / `now` /
 *                    `current_user_name` defaults.
 */
export type EvalContext = {
  values: FieldValueMap
  rows: RowMap
  requestContext?: {
    now?: Date
    /** Org business day (YYYY-MM-DD). `today` defaults use this, never the UTC day. */
    today?: string
    currentUserName?: string | null
  }
}

// --- Helpers ---------------------------------------------------------------

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string' && v.trim() === '') return true
  if (Array.isArray(v) && v.length === 0) return true
  return false
}

function coerceNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Type-tolerant equality for `eq`/`ne`. The designer's LogicBuilder persists
 * comparison values as strings, while responses store typed values (a number
 * field stores `3`, not `"3"`). Strict `===` would make "amount equals 3"
 * false forever, so when exactly one side is a number or boolean we coerce the
 * other side before comparing. String-vs-string stays strict.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (typeof a === 'number' || typeof b === 'number') {
    const na =
      typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN
    const nb =
      typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const toBool = (v: unknown): boolean | undefined =>
      v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined
    const ba = toBool(a)
    const bb = toBool(b)
    return ba !== undefined && bb !== undefined && ba === bb
  }
  return false
}

/**
 * Resolve a field reference. Direct dotted refs into repeating rows return
 * undefined intentionally (we'd need a row index) — use the section-aware
 * rollup operators (`sum_section` etc.) for repeating data.
 */
function resolveFieldRef(ctx: EvalContext, key: string): unknown {
  if (key.includes('.')) return undefined
  return ctx.values[key]
}

// --- Logic evaluator -------------------------------------------------------

/**
 * Evaluate a LogicRule against the given values/rows context.
 * Returns true if the rule is satisfied. An undefined rule is treated as
 * "always true" by the caller, not here — pass-through is up to the renderer.
 */
export function evaluateLogicRule(rule: LogicRule, ctx: EvalContext): boolean {
  switch (rule.op) {
    case 'and':
      return rule.rules.every((r) => evaluateLogicRule(r, ctx))
    case 'or':
      return rule.rules.some((r) => evaluateLogicRule(r, ctx))
    case 'not':
      return !evaluateLogicRule(rule.rule, ctx)
    case 'eq':
      return looseEquals(resolveFieldRef(ctx, rule.field), rule.value)
    case 'ne':
      return !looseEquals(resolveFieldRef(ctx, rule.field), rule.value)
    case 'gt':
      return coerceNumber(resolveFieldRef(ctx, rule.field)) > coerceNumber(rule.value)
    case 'lt':
      return coerceNumber(resolveFieldRef(ctx, rule.field)) < coerceNumber(rule.value)
    case 'gte':
      return coerceNumber(resolveFieldRef(ctx, rule.field)) >= coerceNumber(rule.value)
    case 'lte':
      return coerceNumber(resolveFieldRef(ctx, rule.field)) <= coerceNumber(rule.value)
    case 'in': {
      const v = resolveFieldRef(ctx, rule.field)
      // Multi-select stores arrays — treat as "any overlap".
      if (Array.isArray(v)) return v.some((x) => rule.value.includes(x))
      return rule.value.includes(v)
    }
    case 'notIn': {
      const v = resolveFieldRef(ctx, rule.field)
      if (Array.isArray(v)) return !v.some((x) => rule.value.includes(x))
      return !rule.value.includes(v)
    }
    case 'isSet':
      return !isEmpty(resolveFieldRef(ctx, rule.field))
    case 'isNotSet':
      return isEmpty(resolveFieldRef(ctx, rule.field))
  }
}

// --- Formula evaluator -----------------------------------------------------

/** Exact rational with a positive denominator, always reduced. */
type Rational = { num: bigint; den: bigint }

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new FormulaEvaluationError('Cannot divide by zero in a formula')
  if (den < 0n) {
    num = -num
    den = -den
  }
  const g = gcd(num, den)
  return g === 0n ? { num: 0n, den: 1n } : { num: num / g, den: den / g }
}

const RATIONAL_ONE: Rational = { num: 1n, den: 1n }

/** Decimal places kept by formula division (halves away from zero). */
const FORMULA_DIVISION_SCALE = 10

function addRational(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den)
}

function subRational(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den)
}

function mulRational(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den)
}

function divRational(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new FormulaEvaluationError('Cannot divide by zero in a formula')
  // Halves away from zero at the division scale.
  const num = a.num * b.den * 10n ** BigInt(FORMULA_DIVISION_SCALE)
  const den = a.den * b.num
  const negative = num < 0n !== den < 0n
  const absNum = num < 0n ? -num : num
  const absDen = den < 0n ? -den : den
  const rounded = (absNum * 2n + absDen) / (absDen * 2n)
  return { num: negative && rounded !== 0n ? -rounded : rounded, den: 10n ** BigInt(FORMULA_DIVISION_SCALE) }
}

function cmpRational(a: Rational, b: Rational): number {
  const d = a.num * b.den - b.num * a.den
  return d < 0n ? -1 : d > 0n ? 1 : 0
}

function negativeRational(a: Rational): Rational {
  return { num: -a.num, den: a.den }
}

/** Floored integer quotient (toward −∞), for floor/ceil/round. */
function floorQuotient(num: bigint, den: bigint): bigint {
  const q = num / den
  return num >= 0n || num % den === 0n ? q : q - 1n
}

/**
 * An evaluated operand as an exact rational, or null when it is blank
 * (missing, null, or empty — blanks are skipped by n-ary operators and
 * propagate through binary ones). Anything else that is not an exact
 * decimal throws instead of coercing to 0.
 */
function toOperandRational(value: unknown, what: string): Rational | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new FormulaEvaluationError(`${what} is not a finite number`)
    }
    return scaledToRational(parseExactDecimalParts(String(value))!)
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    const parts = parseExactDecimalParts(value)
    if (!parts) throw new FormulaEvaluationError(`${what} ("${value}") is not a number`)
    return scaledToRational(parts)
  }
  throw new FormulaEvaluationError(`${what} is not a number`)
}

function scaledToRational(parts: { units: bigint; scale: number }): Rational {
  return rational(parts.units, 10n ** BigInt(parts.scale))
}

/**
 * Render an exact result for persistence: canonical trimmed decimal text,
 * carried as a JSON number whenever the double round-trips losslessly
 * (2 × 5 stays 10, not "10") and as an exact string when it cannot.
 */
function renderAmount(value: Rational): number | string {
  const text = renderFraction(value)
  const n = Number(text)
  if (Number.isFinite(n) && String(n) === text) return n
  return text
}

function renderFraction(value: Rational): string {
  const negative = value.num < 0n
  const abs = negative ? -value.num : value.num
  // Long division to 24 places, then trim: every exact decimal terminates
  // long before that, and non-terminating division results were already
  // rounded at FORMULA_DIVISION_SCALE by divRational.
  let remainder = abs % value.den
  const digits = (abs / value.den).toString()
  let fraction = ''
  for (let i = 0; i < 24 && remainder !== 0n; i++) {
    remainder *= 10n
    fraction += (remainder / value.den).toString()
    remainder = remainder % value.den
  }
  fraction = fraction.replace(/0+$/, '')
  const whole = digits.replace(/^0+(?=\d)/, '') || '0'
  const zero = whole === '0' && fraction === ''
  return `${negative && !zero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/**
 * Evaluate a FormulaExpression tree. Returns `number | string | null`.
 *
 * - Arithmetic is exact bigint-rational math: 0.1 + 0.2 is 0.3, and
 *   19.99 × 3 is 59.97 — never the nearest double.
 * - Blanks (missing/null/empty) are skipped by n-ary operators and
 *   propagate through binary ones; an operator with no usable input
 *   returns null (blank), never a silent 0.
 * - Garbage operands and divide-by-zero throw FormulaEvaluationError
 *   naming the cause. Callers persist the failure as a blank field.
 * - `concat` produces a string; `count_section` a count.
 * - `if` returns whichever branch matches the condition.
 * - `*_section` rollups walk `ctx.rows[sectionKey]`.
 */
export function evaluateFormulaTree(
  expr: FormulaExpression,
  ctx: EvalContext,
): number | string | null {
  switch (expr.kind) {
    case 'literal':
      return expr.value

    case 'field_ref': {
      const v = resolveFieldRef(ctx, expr.fieldKey)
      if (v === undefined || v === null) return null
      if (typeof v === 'number' || typeof v === 'string') return v
      throw new FormulaEvaluationError(`the value of "${expr.fieldKey}" is not a number`)
    }

    case 'sum': {
      let acc: Rational | null = null
      for (const e of expr.of) {
        const r = toOperandRational(evaluateFormulaTree(e, ctx), operandName(e))
        if (r !== null) acc = acc === null ? r : addRational(acc, r)
      }
      return acc === null ? null : renderAmount(acc)
    }

    case 'product': {
      let acc: Rational | null = null
      for (const e of expr.of) {
        const r = toOperandRational(evaluateFormulaTree(e, ctx), operandName(e))
        if (r !== null) acc = acc === null ? r : mulRational(acc, r)
      }
      return acc === null ? null : renderAmount(acc)
    }

    case 'subtract': {
      const left = toOperandRational(evaluateFormulaTree(expr.left, ctx), operandName(expr.left))
      const right = toOperandRational(evaluateFormulaTree(expr.right, ctx), operandName(expr.right))
      if (left === null || right === null) return null
      return renderAmount(subRational(left, right))
    }

    case 'divide': {
      const left = toOperandRational(evaluateFormulaTree(expr.left, ctx), operandName(expr.left))
      const right = toOperandRational(evaluateFormulaTree(expr.right, ctx), operandName(expr.right))
      if (left === null || right === null) return null
      return renderAmount(divRational(left, right))
    }

    case 'min': {
      let best: Rational | null = null
      for (const e of expr.of) {
        const r = toOperandRational(evaluateFormulaTree(e, ctx), operandName(e))
        if (r !== null && (best === null || cmpRational(r, best) < 0)) best = r
      }
      return best === null ? null : renderAmount(best)
    }

    case 'max': {
      let best: Rational | null = null
      for (const e of expr.of) {
        const r = toOperandRational(evaluateFormulaTree(e, ctx), operandName(e))
        if (r !== null && (best === null || cmpRational(r, best) > 0)) best = r
      }
      return best === null ? null : renderAmount(best)
    }

    case 'power': {
      const base = toOperandRational(evaluateFormulaTree(expr.base, ctx), operandName(expr.base))
      const exponent = toOperandRational(evaluateFormulaTree(expr.exponent, ctx), operandName(expr.exponent))
      if (base === null || exponent === null) return null
      if (exponent.den === 1n) return renderAmount(integerPower(base, exponent.num))
      return renderApproximate(Math.pow(toFloat(base), toFloat(exponent)), 'power')
    }

    case 'root': {
      const of = toOperandRational(evaluateFormulaTree(expr.of, ctx), operandName(expr.of))
      const degree = toOperandRational(evaluateFormulaTree(expr.degree, ctx), operandName(expr.degree))
      if (of === null || degree === null) return null
      if (degree.num === 0n) throw new FormulaEvaluationError('Cannot take a zeroth root in a formula')
      if (degree.den === 1n) {
        // Integer degrees keep the old sign rule exactly where it is
        // mathematically sound: odd roots of negatives stay negative (cube
        // root of −8 = −2), while an even root of a negative is a refusal —
        // the old code returned a sign-flipped real number for it.
        const n = degree.num
        const ofFloat = toFloat(of)
        if (ofFloat < 0 && n % 2n === 0n) {
          throw new FormulaEvaluationError('Cannot take an even root of a negative value in a formula')
        }
        const r =
          ofFloat < 0
            ? -Math.pow(-ofFloat, 1 / Number(n))
            : Math.pow(ofFloat, 1 / Number(n))
        return renderApproximate(r, 'root')
      }
      // Fractional degrees go straight through the double: a negative base
      // is complex, so Math.pow yields NaN and the refusal below fires.
      return renderApproximate(Math.pow(toFloat(of), 1 / toFloat(degree)), 'root')
    }

    case 'abs': {
      const v = toOperandRational(evaluateFormulaTree(expr.of, ctx), operandName(expr.of))
      if (v === null) return null
      return renderAmount(v.num < 0n ? negativeRational(v) : v)
    }

    case 'round': {
      const v = toOperandRational(evaluateFormulaTree(expr.of, ctx), operandName(expr.of))
      if (v === null) return null
      const places =
        Number.isInteger(expr.places) &&
        (expr.places as number) >= 0 &&
        (expr.places as number) <= 12
          ? (expr.places as number)
          : 0
      // Halves toward +∞ (Math.round semantics).
      const scaled = { num: v.num * 10n ** BigInt(places), den: v.den }
      const rounded = floorQuotient(scaled.num * 2n + scaled.den, scaled.den * 2n)
      return renderAmount({ num: rounded, den: 10n ** BigInt(places) })
    }

    case 'floor': {
      const v = toOperandRational(evaluateFormulaTree(expr.of, ctx), operandName(expr.of))
      if (v === null) return null
      return renderAmount({ num: floorQuotient(v.num, v.den), den: 1n })
    }

    case 'ceil': {
      const v = toOperandRational(evaluateFormulaTree(expr.of, ctx), operandName(expr.of))
      if (v === null) return null
      return renderAmount({ num: -floorQuotient(-v.num, v.den), den: 1n })
    }

    case 'sum_section': {
      const rows = ctx.rows[expr.sectionKey] ?? []
      let acc: Rational | null = null
      for (const row of rows) {
        const r = toOperandRational(row[expr.rowFieldKey], `the value of "${expr.rowFieldKey}"`)
        if (r !== null) acc = acc === null ? r : addRational(acc, r)
      }
      return acc === null ? null : renderAmount(acc)
    }

    case 'count_section':
      return (ctx.rows[expr.sectionKey] ?? []).length

    case 'avg_section': {
      const rows = ctx.rows[expr.sectionKey] ?? []
      let acc: Rational | null = null
      let count = 0
      for (const row of rows) {
        const r = toOperandRational(row[expr.rowFieldKey], `the value of "${expr.rowFieldKey}"`)
        if (r === null) continue
        acc = acc === null ? r : addRational(acc, r)
        count += 1
      }
      if (acc === null || count === 0) return null
      return renderAmount(divRational(acc, { num: BigInt(count), den: 1n }))
    }

    case 'min_section': {
      let best: Rational | null = null
      for (const row of ctx.rows[expr.sectionKey] ?? []) {
        const r = toOperandRational(row[expr.rowFieldKey], `the value of "${expr.rowFieldKey}"`)
        if (r !== null && (best === null || cmpRational(r, best) < 0)) best = r
      }
      return best === null ? null : renderAmount(best)
    }

    case 'max_section': {
      let best: Rational | null = null
      for (const row of ctx.rows[expr.sectionKey] ?? []) {
        const r = toOperandRational(row[expr.rowFieldKey], `the value of "${expr.rowFieldKey}"`)
        if (r !== null && (best === null || cmpRational(r, best) > 0)) best = r
      }
      return best === null ? null : renderAmount(best)
    }

    case 'concat': {
      const sep = expr.separator ?? ''
      return expr.of
        .map((e) => {
          const v = evaluateFormulaTree(e, ctx)
          if (v === null || v === undefined) return ''
          return String(v)
        })
        .join(sep)
    }

    case 'if':
      return evaluateLogicRule(expr.condition, ctx)
        ? evaluateFormulaTree(expr.then, ctx)
        : evaluateFormulaTree(expr.else, ctx)
  }
}

/** Human name of one operand for refusal messages. */
function operandName(expr: FormulaExpression): string {
  if (expr.kind === 'field_ref') return `the value of "${expr.fieldKey}"`
  if (expr.kind === 'literal') return 'a literal value'
  return 'a formula value'
}

function toFloat(value: Rational): number {
  return Number(value.num) / Number(value.den)
}

/** Exact integer power (negative exponents invert; 0^negative throws). */
function integerPower(base: Rational, exponent: bigint): Rational {
  let e = exponent
  let b = base
  if (e < 0n) {
    if (b.num === 0n) throw new FormulaEvaluationError('Cannot raise zero to a negative power in a formula')
    b = rational(b.den, b.num)
    e = -e
  }
  let result: Rational = RATIONAL_ONE
  while (e > 0n) {
    if (e % 2n === 1n) result = mulRational(result, b)
    b = mulRational(b, b)
    e /= 2n
  }
  return result
}

/**
 * The two approximative cases (non-integer power, roots): an exact rational
 * result need not exist, so they compute in double precision and carry the
 * double's exact expansion. A non-finite result throws instead of coercing
 * to 0 — an even root of a negative is a refusal, not a zero.
 */
function renderApproximate(value: number, what: string): number | string {
  if (!Number.isFinite(value)) {
    throw new FormulaEvaluationError(`The ${what} has no finite result in this formula`)
  }
  const parts = parseExactDecimalParts(String(value))
  if (!parts) throw new FormulaEvaluationError(`The ${what} has no finite result in this formula`)
  return renderAmount(rational(parts.units, 10n ** BigInt(parts.scale)))
}

// --- Default-value resolver ------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0')

function localDateString(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * Resolve a DefaultValueExpression to a concrete value for the first render
 * of a field. Returns `undefined` if no default applies (e.g. expression
 * evaluates to null).
 */
export function resolveDefaultValue(expr: DefaultValueExpression, ctx: EvalContext): unknown {
  const now = ctx.requestContext?.now ?? new Date()
  switch (expr.kind) {
    case 'literal':
      return expr.value
    case 'today':
      // Product writers pass the org business day. Without it, fall back to
      // the local wall-clock date — toISOString() would yield the UTC day,
      // the wrong calendar day for evening fills west of Greenwich.
      return ctx.requestContext?.today ?? localDateString(now)
    case 'now':
      // <input type="datetime-local"> expects LOCAL yyyy-mm-ddThh:mm.
      return `${localDateString(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
    case 'current_user_name':
      return ctx.requestContext?.currentUserName ?? null
    case 'expression': {
      // A failing default (divide-by-zero, garbage operand) leaves the field
      // blank rather than failing the whole fill — the failure is still
      // visible, because withComputedFormulas persists null, never 0.
      try {
        return evaluateFormulaTree(expr.expr, ctx) ?? undefined
      } catch (error) {
        if (error instanceof FormulaEvaluationError) return undefined
        throw error
      }
    }
  }
}
