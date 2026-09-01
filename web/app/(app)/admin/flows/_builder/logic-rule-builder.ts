import type { LogicRule } from '@openbooks/forms-core'

export type GroupOp = 'and' | 'or' | 'not'
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
