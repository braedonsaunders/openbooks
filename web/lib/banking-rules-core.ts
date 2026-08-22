/**
 * Pure bank-rule logic — types, the condition evaluator, and split maths — with
 * NO database or server-only imports, so it can be unit-tested directly and
 * reused on either side of the wire. The orchestration layer (banking-rules.ts)
 * composes these with posting + matching primitives.
 */

import { abs as moneyAbs, add, cmp, formatMoney, mulPercent, neg, normalizeMoney, sum } from '@openbooks/engine/src/money.ts'

// ---------------------------------------------------------------------------
// Condition model
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
  value?: string | number | [string | number, string | number]
}

export interface RuleConditionGroup {
  combinator: 'and' | 'or'
  rules: (RuleCondition | RuleConditionGroup)[]
}

export interface RuleCriteria {
  version: 2
  match: RuleConditionGroup
  accountScope?: string[]
}

// ---------------------------------------------------------------------------
// Outcome model
// ---------------------------------------------------------------------------

export interface RuleSplitLine {
  accountId: string
  portion: { kind: 'remainder' } | { kind: 'percent'; value: number } | { kind: 'fixed'; value: string | number }
  partyId?: string | null
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  taxCodeId?: string | null
  description?: string | null
}

export type RuleOutcome =
  | { action: 'exclude' }
  | {
      action: 'categorize'
      version: 2
      mode: 'auto' | 'suggest'
      lines: RuleSplitLine[]
      partyId?: string | null
      memo?: string | null
    }

export function isCategorizeOutcome(o: RuleOutcome): o is Extract<RuleOutcome, { action: 'categorize' }> {
  return o.action === 'categorize'
}

export type RuleRow = {
  id: string
  name: string
  criteria: RuleCriteria
  outcome: RuleOutcome
  priority: number
  is_active: boolean
};

export type BankLine = {
  id: string
  posted_on: string
  amount: string
  description: string | null
  counterparty_ref: string | null
  currency: string
  source: string
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()

/** Evaluate a single condition against a bank line. `now` is injectable for tests. */
export function evaluateCondition(line: BankLine, cond: RuleCondition, now: number = Date.now()): boolean {
  const amount = normalizeMoney(line.amount)
  switch (cond.field) {
    case 'flow': {
      const dir = cmp(amount, '0') >= 0 ? 'in' : 'out'
      return cond.value === 'any' || dir === cond.value
    }
    case 'amount': {
      const absolute = moneyAbs(amount)
      if (cond.op === 'between' && Array.isArray(cond.value)) {
        const [min, max] = cond.value
        try {
          return cmp(absolute, normalizeMoney(String(min))) >= 0 && cmp(absolute, normalizeMoney(String(max))) <= 0
        } catch {
          return false
        }
      }
      let value: string
      try { value = normalizeMoney(String(cond.value)) } catch { return false }
      switch (cond.op) {
        case 'eq': return cmp(absolute, value) === 0
        case 'ne': return cmp(absolute, value) !== 0
        case 'gt': return cmp(absolute, value) > 0
        case 'gte': return cmp(absolute, value) >= 0
        case 'lt': return cmp(absolute, value) < 0
        case 'lte': return cmp(absolute, value) <= 0
        default: return false
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
          if (!Number.isFinite(days)) return false
          const ageMs = Date.parse(`${on}T00:00:00Z`)
          const cutoff = now - days * 86400000
          return Number.isFinite(ageMs) && ageMs >= cutoff
        }
        default: return false
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
        case 'contains': return needle !== '' && hay.includes(needle)
        case 'notContains': return needle !== '' && !hay.includes(needle)
        case 'equals': return hay === needle
        case 'startsWith': return needle !== '' && hay.startsWith(needle)
        case 'endsWith': return needle !== '' && hay.endsWith(needle)
        default: return false
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

export function lineMatchesRule(line: BankLine, criteria: RuleCriteria, now: number = Date.now()): boolean {
  return evaluateGroup(line, criteria.match, now)
}

/** Does this rule apply to the given account? */
export function ruleAppliesToAccount(criteria: RuleCriteria, accountId: string): boolean {
  if (criteria.accountScope && criteria.accountScope.length > 0) {
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

/**
 * Resolve split lines into concrete signed amounts that sum EXACTLY to the
 * negated bank amount. `bankAmount` is signed from the bank's perspective (the
 * offsets carry the opposite sign). Percent lines take a share of the gross
 * absolute amount; fixed lines a set magnitude; the (single) remainder line
 * absorbs whatever is left, keeping the entry balanced exactly at the ledger's
 * numeric(19,4) scale — cents-only rounding here could strand sub-cent deltas
 * outside the posting. If no remainder line exists, the last line absorbs the
 * rounding delta.
 */
export function resolveSplitAmounts(
  bankAmount: string,
  lines: RuleSplitLine[],
): { line: RuleSplitLine; amount: string }[] {
  const gross = normalizeMoney(bankAmount)
  const absGross = moneyAbs(gross)
  const offsetNegative = cmp(gross, '0') >= 0

  const resolved: { line: RuleSplitLine; amount: string }[] = []
  const allocated: string[] = []
  let remainderIdx = -1
  lines.forEach((line, i) => {
    if (line.portion.kind === 'remainder') {
      remainderIdx = i
      resolved.push({ line, amount: '0.0000' })
      return
    }
    const magnitude =
      line.portion.kind === 'percent'
        ? mulPercent(absGross, String(line.portion.value))
        : moneyAbs(normalizeMoney(String(line.portion.value)))
    allocated.push(magnitude)
    resolved.push({ line, amount: offsetNegative ? neg(magnitude) : magnitude })
  })

  const remainderMagnitude = add(absGross, neg(sum(allocated)))
  if (remainderIdx >= 0) {
    resolved[remainderIdx]!.amount = offsetNegative ? neg(remainderMagnitude) : remainderMagnitude
  } else if (resolved.length > 0) {
    const signedRemainder = offsetNegative ? neg(remainderMagnitude) : remainderMagnitude
    resolved[resolved.length - 1]!.amount = add(resolved[resolved.length - 1]!.amount, signedRemainder)
  }

  return resolved.map((r) => ({ line: r.line, amount: formatMoney(r.amount, 4) }))
}
