/**
 * Generic, catalog-driven condition model shared across the app — the data
 * contract behind the reusable <ConditionBuilder> component. A consumer supplies
 * a field catalog (each field has a `kind`); this module resolves the operators
 * valid for that kind and renders a value input of the right shape. Purely
 * structural: any feature that needs a nested and/or rule tree (bank rules,
 * payment-run selection, saved searches) uses these types instead of rolling its
 * own. No app-specific coupling — labels are passed in, not looked up here.
 */

export type FieldKind = 'text' | 'number' | 'enum' | 'date' | 'flow'

/** How the value input behaves for a given operator. */
export type ValueShape = 'none' | 'text' | 'number' | 'range' | 'date' | 'enum' | 'flow'

export interface OperatorDef {
  key: string
  /** Display label; the consumer localizes and passes it through the catalog. */
  label: string
  value: ValueShape
}

export interface FieldDef {
  key: string
  label: string
  kind: FieldKind
  /** For `enum`/`flow` fields — the selectable options (value + label). */
  options?: { value: string; label: string }[]
  /** Placeholder for text/number/date value inputs. */
  placeholder?: string
}

export interface Condition {
  field: string
  op: string
  value?: string | number | [number, number]
}

export interface ConditionGroup {
  combinator: 'and' | 'or'
  rules: (Condition | ConditionGroup)[]
}

export function isConditionGroup(n: Condition | ConditionGroup): n is ConditionGroup {
  return Array.isArray((n as ConditionGroup).rules)
}

/**
 * Default operators per field kind. Keys are stable (persisted in JSONB); labels
 * are English fallbacks a consumer can override via `operatorLabels`.
 */
export const OPERATORS_BY_KIND: Record<FieldKind, OperatorDef[]> = {
  text: [
    { key: 'contains', label: 'contains', value: 'text' },
    { key: 'notContains', label: 'does not contain', value: 'text' },
    { key: 'equals', label: 'is exactly', value: 'text' },
    { key: 'startsWith', label: 'starts with', value: 'text' },
    { key: 'endsWith', label: 'ends with', value: 'text' },
    { key: 'isBlank', label: 'is blank', value: 'none' },
  ],
  number: [
    { key: 'eq', label: '=', value: 'number' },
    { key: 'ne', label: '≠', value: 'number' },
    { key: 'gt', label: '>', value: 'number' },
    { key: 'gte', label: '≥', value: 'number' },
    { key: 'lt', label: '<', value: 'number' },
    { key: 'lte', label: '≤', value: 'number' },
    { key: 'between', label: 'between', value: 'range' },
  ],
  date: [
    { key: 'on', label: 'on', value: 'date' },
    { key: 'before', label: 'before', value: 'date' },
    { key: 'after', label: 'after', value: 'date' },
    { key: 'withinDays', label: 'within last N days', value: 'number' },
  ],
  enum: [{ key: 'equals', label: 'is', value: 'enum' }],
  flow: [{ key: 'is', label: 'is', value: 'flow' }],
}

/** Operators valid for a field's kind, with optional label overrides. */
export function operatorsForField(
  field: FieldDef | undefined,
  operatorLabels?: Record<string, string>,
): OperatorDef[] {
  const ops = field ? OPERATORS_BY_KIND[field.kind] : []
  if (!operatorLabels) return ops
  return ops.map((o) => ({ ...o, label: operatorLabels[o.key] ?? o.label }))
}

/** The value shape an operator expects (drives the input rendered). */
export function valueShapeFor(field: FieldDef | undefined, op: string): ValueShape {
  const ops = field ? OPERATORS_BY_KIND[field.kind] : []
  return ops.find((o) => o.key === op)?.value ?? 'none'
}

/** An empty condition seeded to a field's first valid operator. */
export function newCondition(catalog: FieldDef[]): Condition {
  const field = catalog[0]
  const op = field ? (OPERATORS_BY_KIND[field.kind][0]?.key ?? 'contains') : 'contains'
  return { field: field?.key ?? '', op, value: '' }
}

/**
 * Human-readable one-line summary of a condition group — used in list rows and
 * chips. `and`/`or` join words and the operator labels are passed in so the
 * summary localizes with the rest of the surface.
 */
export function summarizeGroup(
  group: ConditionGroup,
  catalog: FieldDef[],
  labels: { and: string; or: string; operatorLabels?: Record<string, string> },
  depth = 0,
): string {
  const parts = (group.rules ?? []).map((n) => {
    if (isConditionGroup(n)) return `(${summarizeGroup(n, catalog, labels, depth + 1)})`
    return summarizeCondition(n, catalog, labels.operatorLabels)
  })
  const join = group.combinator === 'or' ? ` ${labels.or} ` : ` ${labels.and} `
  return parts.filter(Boolean).join(join)
}

export function summarizeCondition(
  cond: Condition,
  catalog: FieldDef[],
  operatorLabels?: Record<string, string>,
): string {
  const field = catalog.find((f) => f.key === cond.field)
  const fieldLabel = field?.label ?? cond.field
  const opLabel = operatorLabels?.[cond.op] ?? cond.op
  const shape = valueShapeFor(field, cond.op)
  if (shape === 'none') return `${fieldLabel} ${opLabel}`
  let valueLabel: string
  if (Array.isArray(cond.value)) valueLabel = `${cond.value[0]}–${cond.value[1]}`
  else if ((field?.kind === 'enum' || field?.kind === 'flow') && field.options) {
    valueLabel = field.options.find((o) => o.value === cond.value)?.label ?? String(cond.value ?? '')
  } else valueLabel = String(cond.value ?? '')
  return `${fieldLabel} ${opLabel} ${valueLabel}`.trim()
}
