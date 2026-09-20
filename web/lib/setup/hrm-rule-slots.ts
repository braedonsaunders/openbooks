/**
 * HRM rule-slot persistence (pure — no server imports).
 *
 * Two workforce entities edit jsonb rule columns through structured slot
 * fields: hrm-process-templates (applies_to) and leave-policies (applies_to,
 * accrual_rule, carryover_rule). The slots are readable prefills projected
 * by STORED GENERATED columns and are NEVER written; the normalizers fold
 * them back into the rule objects before buildRow. buildRow only emits
 * declared fields, so without this step the folded objects were dropped on
 * create (the row kept the database default: applies to all) and an edit
 * tried to write null into a generated slot column, which Postgres refuses
 * — every process-template edit through Setup failed. This fold runs on
 * both paths: it strips any column that is a generated slot and appends the
 * folded jsonb columns present in the normalized body.
 */
import type { Coerced } from './coerce'

interface RuleSlotEntity {
  /** Generated slot columns: readable, never written. */
  readonly generated: readonly string[]
  /** Folded body key → jsonb column. */
  readonly folded: readonly { key: string; column: string }[]
}

export const RULE_SLOT_ENTITIES: Readonly<Record<string, RuleSlotEntity>> = {
  'hrm-process-templates': {
    generated: ['applies_employer_subsidiary_id', 'applies_department_id'],
    folded: [{ key: 'appliesTo', column: 'applies_to' }],
  },
  'leave-policies': {
    generated: [
      'applies_employer_subsidiary_id',
      'applies_department_id',
      'accrual_kind',
      'accrual_hours',
      'accrual_periods_per_year',
      'carryover_kind',
      'carryover_hours',
      'carryover_expires_after_days',
    ],
    folded: [
      { key: 'appliesTo', column: 'applies_to' },
      { key: 'accrualRule', column: 'accrual_rule' },
      { key: 'carryoverRule', column: 'carryover_rule' },
    ],
  },
}

/**
 * The columns actually written for a rule-slot entity: `cols` minus every
 * generated slot column, plus one jsonb column per folded object present in
 * the normalized body (an object as given; a JSON string parsed; anything
 * else refused by name so a malformed rule never reaches storage as text).
 * Entities without rule slots pass through untouched.
 */
export function applyRuleSlotColumns(
  entityKey: string,
  body: Record<string, unknown>,
  cols: readonly Coerced[],
): { cols: Coerced[] } | { error: string } {
  const spec = RULE_SLOT_ENTITIES[entityKey]
  if (!spec) return { cols: [...cols] }
  const generated = new Set(spec.generated)
  const folded = new Set(spec.folded.map((entry) => entry.column))
  const out = cols.filter((col) => !generated.has(col.column) && !folded.has(col.column))
  for (const entry of spec.folded) {
    const raw = body[entry.key]
    if (raw === undefined) continue
    let value: unknown = raw
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw)
      } catch {
        return { error: `${entry.key} must be valid JSON` }
      }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: `${entry.key} must be a JSON object` }
    }
    out.push({ column: entry.column, value })
  }
  return { cols: out }
}
