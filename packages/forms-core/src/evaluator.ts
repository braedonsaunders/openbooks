// Typed JSON-tree evaluators for form field logic and formulas.
//
// Ported from the beaconhs form builder. This module is the SINGLE
// implementation of the form condition/formula language — the designer
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

import type { DefaultValueExpression, FormulaExpression, LogicRule } from './schema'

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

/**
 * Evaluate a FormulaExpression tree. Returns `number | string | null`.
 *
 * - Pure arithmetic operators coerce inputs to numbers (missing → 0).
 * - `concat` produces a string.
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
      // String values stay as strings; numeric strings coerce automatically
      // when the caller composes them through `sum` etc.
      return typeof v === 'number' ? v : typeof v === 'string' ? v : coerceNumber(v)
    }

    case 'sum':
      return expr.of.reduce<number>((acc, e) => acc + coerceNumber(evaluateFormulaTree(e, ctx)), 0)

    case 'product':
      return expr.of.reduce<number>((acc, e) => acc * coerceNumber(evaluateFormulaTree(e, ctx)), 1)

    case 'subtract':
      return (
        coerceNumber(evaluateFormulaTree(expr.left, ctx)) -
        coerceNumber(evaluateFormulaTree(expr.right, ctx))
      )

    case 'divide': {
      const r = coerceNumber(evaluateFormulaTree(expr.right, ctx))
      // Divide-by-zero short-circuits to 0 so chained formulas don't NaN.
      return r === 0 ? 0 : coerceNumber(evaluateFormulaTree(expr.left, ctx)) / r
    }

    case 'min': {
      if (expr.of.length === 0) return 0
      return Math.min(...expr.of.map((e) => coerceNumber(evaluateFormulaTree(e, ctx))))
    }

    case 'max': {
      if (expr.of.length === 0) return 0
      return Math.max(...expr.of.map((e) => coerceNumber(evaluateFormulaTree(e, ctx))))
    }

    case 'power': {
      const r = Math.pow(
        coerceNumber(evaluateFormulaTree(expr.base, ctx)),
        coerceNumber(evaluateFormulaTree(expr.exponent, ctx)),
      )
      return Number.isFinite(r) ? r : 0
    }

    case 'root': {
      const b = coerceNumber(evaluateFormulaTree(expr.of, ctx))
      const d = coerceNumber(evaluateFormulaTree(expr.degree, ctx))
      if (d === 0) return 0
      // Preserve sign so odd roots of negatives work (cube root of −8 = −2)
      // and even roots of negatives don't produce NaN.
      const r = Math.sign(b) * Math.pow(Math.abs(b), 1 / d)
      return Number.isFinite(r) ? r : 0
    }

    case 'abs':
      return Math.abs(coerceNumber(evaluateFormulaTree(expr.of, ctx)))

    case 'round': {
      const places =
        Number.isInteger(expr.places) &&
        (expr.places as number) >= 0 &&
        (expr.places as number) <= 12
          ? (expr.places as number)
          : 0
      const factor = Math.pow(10, places)
      return Math.round(coerceNumber(evaluateFormulaTree(expr.of, ctx)) * factor) / factor
    }

    case 'floor':
      return Math.floor(coerceNumber(evaluateFormulaTree(expr.of, ctx)))

    case 'ceil':
      return Math.ceil(coerceNumber(evaluateFormulaTree(expr.of, ctx)))

    case 'sum_section': {
      const rows = ctx.rows[expr.sectionKey] ?? []
      return rows.reduce<number>((acc, row) => acc + coerceNumber(row[expr.rowFieldKey]), 0)
    }

    case 'count_section':
      return (ctx.rows[expr.sectionKey] ?? []).length

    case 'avg_section': {
      const rows = ctx.rows[expr.sectionKey] ?? []
      if (rows.length === 0) return null
      const sum = rows.reduce<number>((acc, row) => acc + coerceNumber(row[expr.rowFieldKey]), 0)
      return sum / rows.length
    }

    case 'min_section': {
      const nums = (ctx.rows[expr.sectionKey] ?? []).map((row) =>
        coerceNumber(row[expr.rowFieldKey]),
      )
      return nums.length === 0 ? null : Math.min(...nums)
    }

    case 'max_section': {
      const nums = (ctx.rows[expr.sectionKey] ?? []).map((row) =>
        coerceNumber(row[expr.rowFieldKey]),
      )
      return nums.length === 0 ? null : Math.max(...nums)
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
      // <input type="date"> expects the LOCAL wall-clock date (yyyy-mm-dd).
      // Built from local components — toISOString() would yield the UTC date,
      // the wrong calendar day for evening fills west of Greenwich.
      return localDateString(now)
    case 'now':
      // <input type="datetime-local"> expects LOCAL yyyy-mm-ddThh:mm.
      return `${localDateString(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
    case 'current_user_name':
      return ctx.requestContext?.currentUserName ?? null
    case 'expression': {
      const v = evaluateFormulaTree(expr.expr, ctx)
      return v ?? undefined
    }
  }
}
