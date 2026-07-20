/**
 * Pure bank-rule logic — types, the condition evaluator, and split maths — with
 * NO database or server-only imports, so it can be unit-tested directly and
 * reused on either side of the wire. The orchestration layer (banking-rules.ts)
 * composes these with posting + matching primitives.
 */

// ---------------------------------------------------------------------------
// Condition model (v2)
// ---------------------------------------------------------------------------

export type RuleField = 'description' | 'payee' | 'anyText' | 'reference' | 'amount' | 'flow' | 'date' | 'source'

export type TextOp = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith' | 'isBlank'
export type NumberOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
export type FlowOp = 'is'
export type DateOp = 'on' | 'before' | 'after' | 'withinDays'
export type RuleOp = TextOp | NumberOp | FlowOp | DateOp

export interface RuleCondition {
  field: RuleField
  op: RuleOp
  value?: string | number | [number, number]
}

export interface RuleConditionGroup {
  combinator: 'and' | 'or'
  rules: (RuleCondition | RuleConditionGroup)[]
}

/** v1 flat criteria — retained for backward compatibility. */
export interface RuleCriteria {
  descriptionContains?: string
  amountSign?: 'in' | 'out' | 'any'
  minAmount?: number
  maxAmount?: number
  source?: string
}

/** v2 criteria — a nested condition tree plus rule-level scope. */
export interface RuleCriteriaV2 {
  version: 2
  match: RuleConditionGroup
  accountScope?: string[]
}

export type AnyCriteria = RuleCriteria | RuleCriteriaV2

export function isV2Criteria(c: AnyCriteria): c is RuleCriteriaV2 {
  return (c as RuleCriteriaV2)?.version === 2 && !!(c as RuleCriteriaV2).match
}

// ---------------------------------------------------------------------------
// Outcome model
// ---------------------------------------------------------------------------

export interface RuleSplitLine {
  accountId: string
  portion: { kind: 'remainder' } | { kind: 'percent'; value: number } | { kind: 'fixed'; value: number }
  partyId?: string | null
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  taxCodeId?: string | null
  description?: string | null
}

export type RuleOutcomeV1 =
  | { action: 'exclude' }
  | { action: 'categorize'; accountId: string; partyId?: string | null }

export type RuleOutcomeV2 =
  | { action: 'exclude' }
  | {
      action: 'categorize'
      version: 2
      mode: 'auto' | 'suggest'
      lines: RuleSplitLine[]
      partyId?: string | null
      memo?: string | null
    }

export type AnyOutcome = RuleOutcomeV1 | RuleOutcomeV2

export function isV2Outcome(o: AnyOutcome): o is Extract<RuleOutcomeV2, { action: 'categorize' }> {
  return o?.action === 'categorize' && (o as RuleOutcomeV2 & { version?: number }).version === 2
}

export interface RuleRow {
  id: string
  name: string
  criteria: AnyCriteria
  outcome: AnyOutcome
  priority: number
  is_active: boolean
}

export interface BankLine {
  id: string
  posted_on: string
  amount: string
  description: string | null
  counterparty_ref: string | null
  currency: string
  source: string
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()

/** Evaluate a single condition against a bank line. `now` is injectable for tests. */
export function evaluateCondition(line: BankLine, cond: RuleCondition, now: number = Date.now()): boolean {
  const amount = Number(line.amount)
  switch (cond.field) {
    case 'flow': {
      const dir = amount >= 0 ? 'in' : 'out'
      return cond.value === 'any' || dir === cond.value
    }
    case 'amount': {
      const abs = Math.abs(amount)
      if (cond.op === 'between' && Array.isArray(cond.value)) {
        const [min, max] = cond.value
        return abs >= Number(min) && abs <= Number(max)
      }
      const v = Number(cond.value)
      if (!Number.isFinite(v)) return true
      switch (cond.op) {
        case 'eq': return abs === v
        case 'ne': return abs !== v
        case 'gt': return abs > v
        case 'gte': return abs >= v
        case 'lt': return abs < v
        case 'lte': return abs <= v
        default: return true
      }
    }
    case 'date': {
      const on = line.posted_on
      const v = typeof cond.value === 'string' ? cond.value : ''
      switch (cond.op) {
        case 'on': return on === v
        case 'before': return !!v && on < v
        case 'after': return !!v && on > v
        case 'withinDays': {
          const days = Number(cond.value)
          if (!Number.isFinite(days)) return true
          const ageMs = Date.parse(`${on}T00:00:00Z`)
          const cutoff = now - days * 86400000
          return Number.isFinite(ageMs) && ageMs >= cutoff
        }
        default: return true
      }
    }
    case 'source':
      return norm(line.source) === norm(String(cond.value))
    default: {
      const hay =
        cond.field === 'description'
          ? norm(line.description)
          : cond.field === 'payee'
            ? norm(line.counterparty_ref)
            : cond.field === 'reference'
              ? norm(line.counterparty_ref)
              : norm(`${line.description ?? ''} ${line.counterparty_ref ?? ''}`) // anyText
      const needle = norm(typeof cond.value === 'string' ? cond.value : String(cond.value ?? ''))
      switch (cond.op) {
        case 'isBlank': return hay === ''
        case 'contains': return !needle || hay.includes(needle)
        case 'notContains': return !needle || !hay.includes(needle)
        case 'equals': return hay === needle
        case 'startsWith': return !needle || hay.startsWith(needle)
        case 'endsWith': return !needle || hay.endsWith(needle)
        default: return true
      }
    }
  }
}

function isGroup(n: RuleCondition | RuleConditionGroup): n is RuleConditionGroup {
  return Array.isArray((n as RuleConditionGroup).rules)
}

/** Recursively evaluate an and/or group. An empty group matches nothing. */
export function evaluateGroup(line: BankLine, group: RuleConditionGroup, now: number = Date.now()): boolean {
  const rules = group.rules ?? []
  if (rules.length === 0) return false
  const test = (n: RuleCondition | RuleConditionGroup) =>
    isGroup(n) ? evaluateGroup(line, n, now) : evaluateCondition(line, n, now)
  return group.combinator === 'or' ? rules.some(test) : rules.every(test)
}

/** Legacy v1 matcher — every populated criterion must pass (implicit AND). */
export function matchesLegacyCriteria(line: BankLine, c: RuleCriteria): boolean {
  if (c.descriptionContains) {
    const hay = `${line.description ?? ''} ${line.counterparty_ref ?? ''}`.toLowerCase()
    if (!hay.includes(c.descriptionContains.toLowerCase())) return false
  }
  const amount = Number(line.amount)
  if (c.amountSign === 'in' && amount < 0) return false
  if (c.amountSign === 'out' && amount >= 0) return false
  const abs = Math.abs(amount)
  if (typeof c.minAmount === 'number' && abs < c.minAmount) return false
  if (typeof c.maxAmount === 'number' && abs > c.maxAmount) return false
  if (c.source && line.source !== c.source) return false
  return true
}

/** Unified matcher: v2 condition tree, else legacy flat criteria. */
export function lineMatchesRule(line: BankLine, criteria: AnyCriteria, now: number = Date.now()): boolean {
  if (isV2Criteria(criteria)) return evaluateGroup(line, criteria.match, now)
  return matchesLegacyCriteria(line, criteria)
}

/** Does this rule apply to the given account? (v2 accountScope; v1 = all). */
export function ruleAppliesToAccount(criteria: AnyCriteria, accountId: string): boolean {
  if (isV2Criteria(criteria) && criteria.accountScope && criteria.accountScope.length > 0) {
    return criteria.accountScope.includes(accountId)
  }
  return true
}

/** The first rule (by given order) whose criteria match this line on this account. */
export function firstMatchingRule(line: BankLine, accountId: string, rules: RuleRow[], now: number = Date.now()): RuleRow | undefined {
  return rules.find((r) => ruleAppliesToAccount(r.criteria, accountId) && lineMatchesRule(line, r.criteria, now))
}

// ---------------------------------------------------------------------------
// Split maths
// ---------------------------------------------------------------------------

function money2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2)
}

/**
 * Resolve split lines into concrete signed amounts that sum EXACTLY to the
 * negated bank amount. `bankAmount` is signed from the bank's perspective (the
 * offsets carry the opposite sign). Percent lines take a share of the gross
 * absolute amount; fixed lines a set magnitude; the (single) remainder line
 * absorbs whatever is left, keeping the entry balanced to the penny. If no
 * remainder line exists, the last line absorbs the rounding delta.
 */
export function resolveSplitAmounts(
  bankAmount: string,
  lines: RuleSplitLine[],
): { line: RuleSplitLine; amount: string }[] {
  const gross = Number(bankAmount)
  const absGross = Math.abs(gross)
  const sign = gross >= 0 ? 1 : -1
  const offsetSign = -sign

  const resolved: { line: RuleSplitLine; amount: number }[] = []
  let allocated = 0
  let remainderIdx = -1
  lines.forEach((line, i) => {
    if (line.portion.kind === 'remainder') {
      remainderIdx = i
      resolved.push({ line, amount: 0 })
      return
    }
    const magnitude =
      line.portion.kind === 'percent'
        ? absGross * (line.portion.value / 100)
        : Math.abs(line.portion.value)
    const rounded = Math.round(magnitude * 100) / 100
    allocated += rounded
    resolved.push({ line, amount: offsetSign * rounded })
  })

  const remainderMagnitude = Math.round((absGross - allocated) * 100) / 100
  if (remainderIdx >= 0) {
    resolved[remainderIdx]!.amount = offsetSign * remainderMagnitude
  } else if (resolved.length > 0) {
    resolved[resolved.length - 1]!.amount += offsetSign * remainderMagnitude
  }

  return resolved.map((r) => ({ line: r.line, amount: money2(r.amount) }))
}
