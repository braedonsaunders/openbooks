/**
 * HRM rule-slot persistence (pure — no server imports).
 *
 * Three workforce entities edit jsonb rule columns through structured slot
 * fields: hrm-process-templates (applies_to) and leave-policies (applies_to,
 * accrual_rule, carryover_rule) read their slots back through STORED
 * GENERATED projections, while hrm-review-templates (rating_scale) has no
 * generated projections by design — cycles read the scale through the
 * template row itself, never a slot column. All three share the write
 * contract: slots are readable prefills, never written; the normalizers
 * fold them back into the rule objects before buildRow. buildRow only
 * emits declared fields, so without this step the folded objects were
 * dropped on create (the row kept the database default: applies to all)
 * and an edit tried to write null into a generated slot column, which
 * Postgres refuses — every process-template edit through Setup failed.
 * This fold runs on both paths: it strips any column that is a generated
 * slot and appends the folded jsonb columns present in the normalized body.
 */
import type { Coerced } from './coerce'

interface RuleSlotEntity {
  /** Generated slot columns: readable, never written. */
  readonly generated: readonly string[]
  /** Folded body key → jsonb column. `kind: 'array'` persists a JSON
   *  array (signer roles, merge keys); the default 'object' persists a
   *  JSON object (rules, scales). */
  readonly folded: readonly { key: string; column: string; kind?: 'object' | 'array' }[]
}

export const RULE_SLOT_ENTITIES: Readonly<Record<string, RuleSlotEntity>> = {
  'hrm-process-templates': {
    generated: ['applies_employer_subsidiary_id', 'applies_department_id'],
    folded: [{ key: 'appliesTo', column: 'applies_to' }],
  },
  'hrm-review-templates': {
    // No generated slot columns: the scale has no tenant-identity slots
    // to project, so the drawer fields fold straight into rating_scale.
    generated: [],
    folded: [{ key: 'ratingScale', column: 'rating_scale' }],
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
  // HR-19 begin: document templates (0230) — signer membership and merge
  // keys fold from drawer slots into jsonb arrays. No generated slot
  // columns (review-template precedent): the drawer prefills from the
  // template row itself.
  'hrm-document-templates': {
    generated: [],
    folded: [
      { key: 'signerRoles', column: 'signer_roles', kind: 'array' },
      { key: 'mergeFields', column: 'merge_fields', kind: 'array' },
    ],
  },
  // HR-19 end
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
    if (entry.kind === 'array') {
      if (!Array.isArray(value)) return { error: `${entry.key} must be a JSON array` }
      out.push({ column: entry.column, value })
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: `${entry.key} must be a JSON object` }
    }
    out.push({ column: entry.column, value })
  }
  return { cols: out }
}
