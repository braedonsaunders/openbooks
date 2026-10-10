import type { FlowSubjectProfile, LogicRule } from '@openbooks/forms-core'

export type GroupOp = 'and' | 'or' | 'not'

export interface FieldPickerOption {
  value: string
  label: string
}

/**
 * Condition field picker options: the field's display label once. The
 * storage key used to ride along as a hint ("Total total"), which reads as
 * a stutter and duplicates the key authors never type — the key stays the
 * option value, so selection still stores exactly what the engine matches.
 */
export function fieldPickerOptions(profile: FlowSubjectProfile): FieldPickerOption[] {
  return profile.fields.map((f) => ({ value: f.key, label: f.label }))
}
type SourceGroupOp = Exclude<GroupOp, 'not'>

export const defaultLeaf = (field: string): LogicRule => ({ op: 'isSet', field })

/** Build a group, retaining a source combinator when wrapping its children in NOT. */
export function makeGroup(
  op: GroupOp,
  children: LogicRule[],
  fallbackField: string,
  previousOp?: SourceGroupOp,
): LogicRule {
  if (op === 'not') {
    if (children.length === 0 && previousOp === undefined) {
      return { op: 'not', rule: defaultLeaf(fallbackField) }
    }
    const rule = children.length === 1 ? children[0] : { op: previousOp ?? 'and', rules: children }
    return { op: 'not', rule: rule ?? defaultLeaf(fallbackField) }
  }
  return { op, rules: children }
}

/** Preserve entered decimal text and carry its numeric meaning independently of storage type. */
export function withRuleValueType(rule: LogicRule, fieldType: string): LogicRule {
  if (!("value" in rule)) return rule;
  const { valueType: _valueType, ...base } = rule;
  return fieldType === "number" ? { ...base, valueType: "number" } : base;
}
