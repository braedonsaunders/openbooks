import type {
  RuleCriteria,
  RuleOutcome,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    if (op !== 'equals') return { ok: false, error: 'source requires the "equals" operator' }
    const value = typeof raw.value === 'string' ? raw.value.trim() : ''
    if (!value) return { ok: false, error: 'source requires a value' }
    return { ok: true, value: { field: 'source', op: 'equals', value: value.slice(0, 40) } }
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
    const timestamp = Date.parse(`${v}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== v) {
      return { ok: false, error: 'date must be a valid YYYY-MM-DD date' }
    }
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
  if (!isRecord(raw)) return { ok: false, error: 'each condition group must be an object' }
  const g = raw
  if (g.combinator !== 'and' && g.combinator !== 'or') {
    return { ok: false, error: 'condition group combinator must be "and" or "or"' }
  }
  const combinator = g.combinator
  if (!Array.isArray(g.rules) || g.rules.length === 0) {
    return { ok: false, error: 'each condition group needs at least one condition' }
  }
  const rawRules = g.rules
  const rules: (RuleCondition | RuleConditionGroup)[] = []
  for (const r of rawRules) {
    if (!isRecord(r)) return { ok: false, error: 'each condition must be an object' }
    const rec = r
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

export function validateCriteria(raw: unknown): ValidationResult<RuleCriteria> {
  if (!isRecord(raw)) return { ok: false, error: 'criteria must be an object' }
  const c = raw
  if (c.version !== 2) return { ok: false, error: 'criteria version must be 2' }
  const group = validateGroup(c.match, 0, { n: 0 })
  if (!group.ok) return group
  const value: RuleCriteria = { version: 2, match: group.value }
  if (c.accountScope !== undefined) {
    if (!Array.isArray(c.accountScope) || !c.accountScope.every(isUuidLike)) {
      return { ok: false, error: 'account scope must contain only account IDs' }
    }
    const scope = [...new Set(c.accountScope)]
    if (scope.length !== c.accountScope.length) return { ok: false, error: 'account scope contains duplicate accounts' }
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
  } else if (p.kind === 'remainder') {
    portion = { kind: 'remainder' }
  } else {
    return { ok: false, error: 'portion kind must be remainder, percent, or fixed' }
  }
  const line: RuleSplitLine = { accountId: raw.accountId, portion }
  for (const k of ['partyId', 'departmentId', 'projectId', 'locationId', 'classId', 'taxCodeId'] as const) {
    if (raw[k] !== undefined && raw[k] !== null && !isUuidLike(raw[k])) {
      return { ok: false, error: `${k} must be a valid ID` }
    }
    if (isUuidLike(raw[k])) line[k] = raw[k] as string
  }
  if (typeof raw.description === 'string' && raw.description.trim()) line.description = raw.description.slice(0, 200)
  return { ok: true, value: line }
}

export function validateOutcome(raw: unknown): ValidationResult<RuleOutcome> {
  if (!isRecord(raw)) return { ok: false, error: 'outcome must be an object' }
  const o = raw
  if (o.action === 'exclude') return { ok: true, value: { action: 'exclude' } }
  if (o.action !== 'categorize') return { ok: false, error: 'outcome action must be "exclude" or "categorize"' }

  if (o.version !== 2) return { ok: false, error: 'categorize outcome version must be 2' }
  if (o.mode !== 'auto' && o.mode !== 'suggest') return { ok: false, error: 'mode must be "auto" or "suggest"' }

  const rawLines = Array.isArray(o.lines) ? o.lines : []
  if (rawLines.length === 0) return { ok: false, error: 'a categorize rule needs at least one line' }
  if (rawLines.length > MAX_SPLIT_LINES) return { ok: false, error: 'too many split lines' }
  const lines: RuleSplitLine[] = []
  let remainderCount = 0
  for (const rl of rawLines) {
    if (!isRecord(rl)) return { ok: false, error: 'each split line must be an object' }
    const res = validateSplitLine(rl)
    if (!res.ok) return res
    if (res.value.portion.kind === 'remainder') remainderCount++
    lines.push(res.value)
  }
  if (remainderCount > 1) return { ok: false, error: 'only one line can be the remainder' }

  const outcome: Extract<RuleOutcome, { action: 'categorize' }> = { action: 'categorize', version: 2, mode: o.mode, lines }
  if (o.partyId !== undefined && o.partyId !== null && !isUuidLike(o.partyId)) {
    return { ok: false, error: 'partyId must be a valid ID' }
  }
  if (isUuidLike(o.partyId)) outcome.partyId = o.partyId
  if (typeof o.memo === 'string' && o.memo.trim()) outcome.memo = o.memo.slice(0, 300)
  return { ok: true, value: outcome }
}
