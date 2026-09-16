/**
 * Db-free view model for the Features switchboard hierarchy. The registry
 * already declares the tree via `parentKey` (`requiresAll` entries are
 * cross-module requirements, never children); this module turns a flat
 * registry-order row list plus raw switch state into nested sections for
 * `FeaturesWorkspace`. Pure: no database, no `server-only`, safe to import
 * from the client island. Hiding a child never mutates stored values — the
 * input rows and state are only read.
 */

export interface FeatureTreeRow {
  key: string
  category: string
  parentKey?: string
  requiresAll?: string[]
  recommends?: string[]
}

export type FeatureSwitchState = Record<string, boolean>

export interface FeatureTreeNode {
  row: FeatureTreeRow
  /** Effective on/off: the switch AND every requirement (parent + requiresAll). */
  on: boolean
  /** Requirement keys (parent first) whose switch is currently off. */
  missingRequirements: string[]
  /** False only for children hidden while their parent is off. */
  visible: boolean
}

export interface FeatureTreeGroup {
  parent: FeatureTreeNode
  /** Every child in registry order, visible or not. */
  children: FeatureTreeNode[]
  /** Children rendered under the parent (empty while the parent is off). */
  visibleChildren: FeatureTreeNode[]
  /** Children currently hidden because the parent is off. */
  hiddenChildCount: number
}

export interface FeatureTreeSection {
  category: string
  groups: FeatureTreeGroup[]
  /** Visible rows only, so the header count stays honest while children hide. */
  visibleTotal: number
  visibleOn: number
}

/** Hard requirements normalized across single-parent and multi-dependency
 * declarations. Stable ordering keeps UI copy deterministic. */
export function featureRowRequirements(row: FeatureTreeRow): string[] {
  return [...new Set([...(row.parentKey ? [row.parentKey] : []), ...(row.requiresAll ?? [])])]
}

/** Effective on/off for one key against raw switch state. Mirrors the
 * engine's resolution (a child can never resolve on while a requirement is
 * off) and fails closed on registry cycles, like the engine. */
export function resolveFeatureOn(
  rows: FeatureTreeRow[],
  state: FeatureSwitchState,
  key: string,
): boolean {
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const resolving = new Set<string>()
  const visit = (current: string): boolean => {
    const row = byKey.get(current)
    if (!row) return false
    if (resolving.has(current)) return false
    resolving.add(current)
    const missing = featureRowRequirements(row).some((required) => !visit(required))
    resolving.delete(current)
    if (missing) return false
    return Boolean(state[current])
  }
  return visit(key)
}

function missingRequirements(
  byKey: Map<string, FeatureTreeRow>,
  state: FeatureSwitchState,
  row: FeatureTreeRow,
): string[] {
  return featureRowRequirements(row).filter((required) => {
    const requiredRow = byKey.get(required)
    if (!requiredRow) return true
    return !resolveFeatureOn([...byKey.values()], state, required)
  })
}

/**
 * Nest children under their parent row. Parents keep registry order within
 * their own category section; children attach to the parent's group (even
 * across categories — e.g. accounting's `advancedClose` under platform's
 * `flows`) in registry order. Rows with `requiresAll` but no `parentKey`
 * stay top-level. Children of an off parent are excluded from the visible
 * rows and counts; their stored values are untouched.
 */
export function buildFeatureTree(
  rows: FeatureTreeRow[],
  state: FeatureSwitchState,
  categoryOrder: readonly string[],
): FeatureTreeSection[] {
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const allRows = [...byKey.values()]

  const toNode = (row: FeatureTreeRow, visible: boolean): FeatureTreeNode => ({
    row,
    on: visible && resolveFeatureOn(allRows, state, row.key),
    missingRequirements: missingRequirements(byKey, state, row),
    visible,
  })

  const groupsByParent = new Map<string, FeatureTreeNode[]>()
  const topLevel: FeatureTreeRow[] = []
  for (const row of allRows) {
    const parent = row.parentKey ? byKey.get(row.parentKey) : undefined
    if (row.parentKey && parent) {
      const siblings = groupsByParent.get(parent.key) ?? []
      siblings.push(toNode(row, false))
      groupsByParent.set(parent.key, siblings)
    } else {
      // No parentKey, or an unknown parentKey: fail visible as a top-level row.
      topLevel.push(row)
    }
  }

  const groups: FeatureTreeGroup[] = topLevel.map((row) => {
    const parent = toNode(row, true)
    const children = groupsByParent.get(row.key) ?? []
    const visibleChildren = parent.on
      ? children.map((child) => ({ ...child, visible: true, on: resolveFeatureOn(allRows, state, child.row.key) }))
      : []
    return { parent, children, visibleChildren, hiddenChildCount: children.length - visibleChildren.length }
  })

  const order = new Map(categoryOrder.map((category, index) => [category, index]))
  const sections = new Map<string, FeatureTreeGroup[]>()
  for (const group of groups) {
    const siblings = sections.get(group.parent.row.category) ?? []
    siblings.push(group)
    sections.set(group.parent.row.category, siblings)
  }

  return [...sections.entries()]
    .sort(([a], [b]) => (order.get(a) ?? order.size) - (order.get(b) ?? order.size))
    .map(([category, categoryGroups]) => {
      const visible = categoryGroups.flatMap((group) => [group.parent, ...group.visibleChildren])
      return {
        category,
        groups: categoryGroups,
        visibleTotal: visible.length,
        visibleOn: visible.filter((node) => node.on).length,
      }
    })
}
