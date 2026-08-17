// Filter → SQL compilation for custom reports. The report studio stores one
// canonical nested and/or rule tree and compiles it for a plain pg client.
//
// Identifiers are never interpolated from user input: column keys must
// resolve through the entity catalog, and values always bind as numbered
// parameters collected by SqlParams.

import { columnRef, type ReportEntity } from './entities'
import type { ReportCustomQuery, ReportRule, ReportRuleGroup } from './types'

const MAX_TREE_DEPTH = 5
const MAX_TREE_RULES = 60

/** Ordered bind-parameter sink. `add(v)` returns the `$n` placeholder.
 *  `offset` numbers the first placeholder after params a caller has already
 *  bound (the insights compiler binds its org id first, then reuses this sink
 *  for an entity's baseFilter). */
export class SqlParams {
  readonly values: unknown[] = []
  constructor(private readonly offset: number = 0) {}
  add(v: unknown): string {
    this.values.push(v)
    return `$${this.offset + this.values.length}`
  }
}

function isRuleGroup(r: ReportRule | ReportRuleGroup): r is ReportRuleGroup {
  return typeof r === 'object' && r !== null && Array.isArray((r as ReportRuleGroup).rules)
}

/** `col >= date_trunc(unit, now()) AND col < date_trunc(unit, now()) + 1 unit` —
 *  the half-open current period for the "is today / this week / …" operators.
 *  Pure SQL (no bound params) so the clause re-anchors to the DB clock. `unit`
 *  is a compile-time literal, never user input. */
function currentPeriodClause(col: string, unit: 'day' | 'week' | 'month' | 'year'): string {
  return `(${col} >= date_trunc('${unit}', now()) AND ${col} < date_trunc('${unit}', now()) + interval '1 ${unit}')`
}

/** Compile one leaf clause. Returns null when the clause is invalid or a
 *  no-op (unknown column, missing value) so half-built filters degrade
 *  gracefully. */
export function compileRule(
  entity: ReportEntity,
  rule: { column: string; op: string; value?: unknown },
  params: SqlParams,
): string | null {
  const col = columnRef(entity, rule.column)
  if (!col) return null
  const v = rule.value
  switch (rule.op) {
    case 'eq':
      if (v === null || typeof v === 'undefined' || v === '') return null
      return `${col} = ${params.add(v)}`
    case 'neq':
      if (v === null || typeof v === 'undefined' || v === '') return null
      return `${col} <> ${params.add(v)}`
    // Per-element bound params (`IN ($1, $2)`).
    case 'in':
      if (Array.isArray(v) && v.length) {
        return `(${col} IN (${v.map((x) => params.add(x)).join(', ')}))`
      }
      return null
    case 'not_in':
      if (Array.isArray(v) && v.length) {
        return `(${col} NOT IN (${v.map((x) => params.add(x)).join(', ')}))`
      }
      return null
    case 'gte':
      if (v === null || typeof v === 'undefined' || v === '') return null
      return `${col} >= ${params.add(v)}`
    case 'lte':
      if (v === null || typeof v === 'undefined' || v === '') return null
      return `${col} <= ${params.add(v)}`
    case 'is_null':
      return `${col} IS NULL`
    case 'is_not_null':
      return `${col} IS NOT NULL`
    case 'is_true':
      return `${col} IS TRUE`
    case 'is_false':
      return `${col} IS FALSE`
    case 'contains':
      if (v === null || typeof v === 'undefined' || v === '') return null
      return `${col}::text ILIKE ${params.add('%' + String(v) + '%')}`
    case 'between_days_ago': {
      const days = Number(v ?? 30)
      if (!Number.isFinite(days)) return null
      // ISO string, not a Date — pg encodes strings predictably for both
      // date and timestamptz columns.
      const fromDate = new Date(Date.now() - days * 24 * 3600 * 1000)
      return `${col} >= ${params.add(fromDate.toISOString())}`
    }
    // Forward window: due on/before now + N days — INCLUDES already-overdue
    // rows (col < now). Drives "coming due / expiring" reports.
    case 'due_within_days': {
      const days = Number(v ?? 30)
      if (!Number.isFinite(days)) return null
      const toDate = new Date(Date.now() + days * 24 * 3600 * 1000)
      return `${col} <= ${params.add(toDate.toISOString())}`
    }
    // Relative-date ops compile to pure SQL (no bound param) so they re-anchor
    // to the DB clock on every run. Each op is bounded on BOTH sides — "is this
    // month" means within the current month, not "any time from the start of
    // this month onwards" (which would sweep in future-dated due values).
    case 'since_today':
      return currentPeriodClause(col, 'day')
    case 'this_week':
      return currentPeriodClause(col, 'week')
    case 'this_month':
      return currentPeriodClause(col, 'month')
    case 'this_year':
      return currentPeriodClause(col, 'year')
    case 'before_now':
      return `${col} < now()`
    default:
      return null
  }
}

/** Nested and/or tree. Throws on absurd trees (depth/size caps) since
 *  those only arise from hand-crafted payloads, not the studio UI. */
export function compileRuleGroup(
  entity: ReportEntity,
  group: ReportRuleGroup,
  params: SqlParams,
): string | null {
  let ruleCount = 0

  function walk(g: ReportRuleGroup, depth: number): string | null {
    if (depth > MAX_TREE_DEPTH) throw new Error('Filter tree too deep')
    const combinator = g.combinator === 'or' ? ' OR ' : ' AND '
    const parts: string[] = []
    for (const r of g.rules ?? []) {
      if (++ruleCount > MAX_TREE_RULES) throw new Error('Filter tree too large')
      const compiled = isRuleGroup(r)
        ? walk(r, depth + 1)
        : compileRule(entity, { column: r.field, op: r.op, value: r.value }, params)
      if (compiled) parts.push(compiled)
    }
    if (!parts.length) return null
    const joined = parts.length === 1 ? parts[0]! : `(${parts.join(combinator)})`
    return g.not ? `NOT (${joined})` : joined
  }

  return walk(group, 1)
}

/** Resolve a stored canonical filter tree into one WHERE fragment. */
export function compileCustomFilters(
  entity: ReportEntity,
  plan: Pick<ReportCustomQuery, 'filters'>,
  params: SqlParams,
): string | null {
  if (plan.filters && Array.isArray(plan.filters.rules) && plan.filters.rules.length) {
    return compileRuleGroup(entity, plan.filters, params)
  }
  return null
}
