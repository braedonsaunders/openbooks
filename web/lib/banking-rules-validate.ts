import type {
  AnyCriteria,
  AnyOutcome,
  RuleCondition,
  RuleConditionGroup,
  RuleSplitLine,
} from './banking-rules'

/**
 * Server-side validation + normalization of bank-rule JSON. Turns an untrusted
 * request body into a stored `criteria` / `outcome` shape, rejecting malformed
 * trees. Shared by the CRUD route and the preview route so a draft rule is
 * validated the same way whether it's being saved or dry-run.
 */

const TEXT_FIELDS = new Set(['description', 'payee', 'anyText', 'reference'])
const TEXT_OPS = new Set(['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'isBlank'])
const NUMBER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'])
const DATE_OPS = new Set(['on', 'before', 'after', 'withinDays'])

const MAX_CONDITIONS = 40
const MAX_DEPTH = 4
const MAX_SPLIT_LINES = 20

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isUuidLike(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

function validateCondition(raw: Record<string, unknown>): ValidationResult<RuleCondition> {
  const field = String(raw.field ?? '')
  const op = String(raw.op ?? '')

  if (field === 'flow') {
    if (op !== 'is') return { ok: false, error: 'flow requires the "is" operator' }
    const v = String(raw.value ?? 'any')
    if (!['in', 'out', 'any'].includes(v)) return { ok: false, error: 'flow value must be in / out / any' }
    return { ok: true, value: { field: 'flow', op: 'is', value: v as 'in' | 'out' } }
  }
  if (field === 'source') {
    return { ok: true, value: { field: 'source', op: 'equals', value: String(raw.value ?? '').slice(0, 40) } }
  }
  if (field === 'amount') {
    if (!NUMBER_OPS.has(op)) return { ok: false, error: `invalid amount operator "${op}"` }
    if (op === 'between') {
      const arr = raw.value
      if (!Array.isArray(arr) || arr.length !== 2) return { ok: false, error: 'between needs [min, max]' }
      const min = Number(arr[0])
      const max = Number(arr[1])
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
        return { ok: false, error: 'between bounds must be non-negative numbers' }
      }
      if (min > max) return { ok: false, error: 'between min cannot exceed max' }
      return { ok: true, value: { field: 'amount', op: 'between', value: [min, max] } }
    }
    const n = Number(raw.value)
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'amount must be a non-negative number' }
    return { ok: true, value: { field: 'amount', op: op as RuleCondition['op'], value: n } }
  }
  if (field === 'date') {
    if (!DATE_OPS.has(op)) return { ok: false, error: `invalid date operator "${op}"` }
    if (op === 'withinDays') {
      const n = Number(raw.value)
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'within days must be a positive number' }
      return { ok: true, value: { field: 'date', op: 'withinDays', value: n } }
    }
    const v = String(raw.value ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: 'date must be YYYY-MM-DD' }
    return { ok: true, value: { field: 'date', op: op as RuleCondition['op'], value: v } }
  }
  if (TEXT_FIELDS.has(field)) {
    if (!TEXT_OPS.has(op)) return { ok: false, error: `invalid text operator "${op}"` }
    if (op === 'isBlank') return { ok: true, value: { field: field as RuleCondition['field'], op: 'isBlank' } }
    const v = String(raw.value ?? '').slice(0, 200)
    if (v.trim() === '') return { ok: false, error: 'this condition needs a value' }
    return { ok: true, value: { field: field as RuleCondition['field'], op: op as RuleCondition['op'], value: v } }
  }
  return { ok: false, error: `unknown field "${field}"` }
}

function validateGroup(raw: unknown, depth: number, count: { n: number }): ValidationResult<RuleConditionGroup> {
  if (depth > MAX_DEPTH) return { ok: false, error: 'condition nesting is too deep' }
  const g = (raw ?? {}) as Record<string, unknown>
  const combinator = g.combinator === 'or' ? 'or' : 'and'
  const rawRules = Array.isArray(g.rules) ? g.rules : []
  const rules: (RuleCondition | RuleConditionGroup)[] = []
  for (const r of rawRules) {
    const rec = (r ?? {}) as Record<string, unknown>
    if (Array.isArray(rec.rules)) {
      const sub = validateGroup(rec, depth + 1, count)
      if (!sub.ok) return sub
      rules.push(sub.value)
    } else {
      count.n++
      if (count.n > MAX_CONDITIONS) return { ok: false, error: 'too many conditions' }
      const cond = validateCondition(rec)
      if (!cond.ok) return cond
      rules.push(cond.value)
    }
  }
  return { ok: true, value: { combinator, rules } }
}

export function validateCriteria(raw: unknown): ValidationResult<AnyCriteria> {
  const c = (raw ?? {}) as Record<string, unknown>
  const group = validateGroup(c.match, 0, { n: 0 })
  if (!group.ok) return group
  const value: AnyCriteria = { version: 2, match: group.value }
  if (Array.isArray(c.accountScope)) {
    const scope = c.accountScope.filter(isUuidLike)
    if (scope.length > 0) value.accountScope = scope
  }
  return { ok: true, value }
}

function validateSplitLine(raw: Record<string, unknown>): ValidationResult<RuleSplitLine> {
  if (!isUuidLike(raw.accountId)) return { ok: false, error: 'each split line needs an account' }
  const p = (raw.portion ?? {}) as Record<string, unknown>
  let portion: RuleSplitLine['portion']
  if (p.kind === 'percent') {
    const v = Number(p.value)
    if (!Number.isFinite(v) || v <= 0 || v > 100) return { ok: false, error: 'percent must be between 0 and 100' }
    portion = { kind: 'percent', value: v }
  } else if (p.kind === 'fixed') {
    const v = Number(p.value)
    if (!Number.isFinite(v) || v <= 0) return { ok: false, error: 'fixed amount must be positive' }
    portion = { kind: 'fixed', value: v }
  } else {
    portion = { kind: 'remainder' }
  }
  const line: RuleSplitLine = { accountId: raw.accountId, portion }
  for (const k of ['partyId', 'departmentId', 'projectId', 'locationId', 'classId', 'taxCodeId'] as const) {
    if (isUuidLike(raw[k])) line[k] = raw[k] as string
  }
  if (typeof raw.description === 'string' && raw.description.trim()) line.description = raw.description.slice(0, 200)
  return { ok: true, value: line }
}

export function validateOutcome(raw: unknown): ValidationResult<AnyOutcome> {
  const o = (raw ?? {}) as Record<string, unknown>
  if (o.action === 'exclude') return { ok: true, value: { action: 'exclude' } }
  if (o.action !== 'categorize') return { ok: false, error: 'outcome action must be "exclude" or "categorize"' }

  const rawLines = Array.isArray(o.lines) ? o.lines : []
  if (rawLines.length === 0) return { ok: false, error: 'a categorize rule needs at least one line' }
  if (rawLines.length > MAX_SPLIT_LINES) return { ok: false, error: 'too many split lines' }
  const lines: RuleSplitLine[] = []
  let remainderCount = 0
  for (const rl of rawLines) {
    const res = validateSplitLine((rl ?? {}) as Record<string, unknown>)
    if (!res.ok) return res
    if (res.value.portion.kind === 'remainder') remainderCount++
    lines.push(res.value)
  }
  if (remainderCount > 1) return { ok: false, error: 'only one line can be the remainder' }

  const mode = o.mode === 'auto' ? 'auto' : 'suggest'
  const outcome: Extract<AnyOutcome, { version: 2 }> = { action: 'categorize', version: 2, mode, lines }
  if (isUuidLike(o.partyId)) outcome.partyId = o.partyId
  if (typeof o.memo === 'string' && o.memo.trim()) outcome.memo = o.memo.slice(0, 300)
  return { ok: true, value: outcome }
}
