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
  group?: string
  parentKey?: string
  requiresAll?: string[]
  recommends?: string[]
}

export type FeatureSwitchState = Record<string, boolean>

/**
 * Refusal-body → user message for a failed toggle PUT. Pure (the catalog
 * lookup is injected) so the mapping is unit-testable: every typed refusal
 * the route can send resolves to its localized message, and anything else —
 * unknown codes, malformed or empty bodies — falls back to the generic
 * blocked message instead of a raw code or silence.
 */
export function featureToggleRefusalMessage(
  payload: unknown,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const body = (payload ?? {}) as {
    error?: unknown
    requiredKeys?: unknown
    dependentKeys?: unknown
  }
  const titles = (keys: unknown): string =>
    (Array.isArray(keys) ? keys : [])
      .filter((key): key is string => typeof key === 'string')
      .map((key) => t(`features.${key}.title`))
      .join(', ')
  if (body.error === 'feature-dependency') {
    return t('setup.features.errors.dependency', { features: titles(body.requiredKeys) })
  }
  if (body.error === 'feature-dependents-enabled') {
    return t('setup.features.errors.dependents', { features: titles(body.dependentKeys) })
  }
  return t('setup.features.errors.blocked')
}

export interface FeatureTreeNode {
  row: FeatureTreeRow
  /** Effective on/off: the switch AND every requirement (parent + requiresAll). */
  on: boolean
  /** Requirement keys (parent first) whose switch is currently off. */
  missingRequirements: string[]
  /** False only for children hidden while their parent is off. */
  visible: boolean
  /** Nesting distance from the group's top-level parent: 1 for a direct
   *  child, 2 for a child of that child, and so on. The switchboard indents
   *  by this so a sub-sub-feature reads as subordinate rather than sibling. */
  depth: number
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

/** Company-wide effective counts include every unique registered capability. */
export function summarizeFeatures(rows: FeatureTreeRow[], state: FeatureSwitchState): { n: number; total: number } {
  const unique = [...new Map(rows.map((row) => [row.key, row])).values()]
  return {
    n: unique.filter((row) => resolveFeatureOn(unique, state, row.key)).length,
    total: unique.length,
  }
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
 * their own category section; children attach to their ancestor's group in
 * registry order. Nesting stops at a category boundary: a child declared in
 * another tab (finance's `advancedClose` under platform's `flows`) is a
 * top-level row in its own tab, carrying its parent as a "Requires" reason,
 * so every switch lives on the tab its registry category names. Rows with
 * `requiresAll` but no `parentKey` stay top-level. Children of an off parent
 * are excluded from the visible rows and counts; their stored values are
 * untouched.
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
    depth: 0,
    on: resolveFeatureOn(allRows, state, row.key),
    missingRequirements: missingRequirements(byKey, state, row),
    visible,
  })

  // Walk to the TOP-LEVEL ancestor within the row's category, not just the
  // immediate parent. The switchboard has two visual levels, but the
  // registry nests deeper than that — projects > timeTracking > fieldTime,
  // and every HRM module under Human resources. Attaching only direct
  // children of a top-level row would silently drop the deeper rows off the
  // page entirely, so an org could never switch them on. Depth is carried so
  // the row can indent.
  const ancestry = (row: FeatureTreeRow): { root: FeatureTreeRow; depth: number } => {
    let current = row
    let depth = 0
    const seen = new Set<string>([row.key])
    while (current.parentKey) {
      const parent = byKey.get(current.parentKey)
      // Unknown parent: fail visible as a top-level row rather than vanish.
      // A parent in another category ends the walk: the row stays on its
      // own tab, gated by its requirement instead of hidden under a row
      // the operator is not looking at.
      if (!parent || seen.has(parent.key) || parent.category !== current.category) break
      seen.add(parent.key)
      current = parent
      depth += 1
    }
    return { root: current, depth }
  }

  const groupsByParent = new Map<string, FeatureTreeNode[]>()
  const topLevel: FeatureTreeRow[] = []
  for (const row of allRows) {
    const { root, depth } = ancestry(row)
    if (depth > 0) {
      const siblings = groupsByParent.get(root.key) ?? []
      siblings.push({ ...toNode(row, false), depth })
      groupsByParent.set(root.key, siblings)
    } else {
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

/** Lowercased, accent-free text so "resume" finds "Résumé" in every locale. */
function foldSearchText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase()
}

/**
 * Search predicate over one row's displayed text (title, description, and
 * whatever else the caller supplies). Every whitespace-separated term must
 * appear somewhere in that text, so "bank feed" narrows rather than widens.
 * Returns null for a blank query: nothing to filter.
 */
export function featureSearchMatcher(
  query: string,
  textFor: (row: FeatureTreeRow) => string[],
): ((row: FeatureTreeRow) => boolean) | null {
  const terms = foldSearchText(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return (row) => {
    const haystack = foldSearchText(textFor(row).join(' '))
    return terms.every((term) => haystack.includes(term))
  }
}

/**
 * Narrow built sections to the rows a search matches. A group survives when
 * its parent or any child matches. A matching parent keeps its normal
 * children; otherwise only the matching children render, INCLUDING children
 * hidden behind an off parent — a search for a capability must find it, and
 * the row arrives locked with its "Requires" reason rather than not at all.
 * Empty sections drop out; counts cover the rendered rows only.
 */
export function filterFeatureTree(
  sections: FeatureTreeSection[],
  matches: (row: FeatureTreeRow) => boolean,
): FeatureTreeSection[] {
  return sections
    .map((section) => {
      const groups = section.groups.flatMap((group): FeatureTreeGroup[] => {
        if (matches(group.parent.row)) return [group]
        const matched = group.children.filter((child) => matches(child.row))
        if (matched.length === 0) return []
        const visibleChildren = matched.map((child) => ({ ...child, visible: true }))
        return [{ ...group, visibleChildren, hiddenChildCount: 0 }]
      })
      const rendered = groups.flatMap((group) => [group.parent, ...group.visibleChildren])
      return {
        category: section.category,
        groups,
        visibleTotal: rendered.length,
        visibleOn: rendered.filter((node) => node.on).length,
      }
    })
    .filter((section) => section.groups.length > 0)
}

/** Ordered settings sections. Every root and its hierarchy is rendered once;
 * new capabilities without presentation metadata stay visible under Other. */
export function groupFeatureSections(
  section: FeatureTreeSection,
  groupOrder: readonly string[],
): { key: string; section: FeatureTreeSection }[] {
  const grouped = new Map<string, FeatureTreeGroup[]>();
  for (const group of section.groups) {
    const key = group.parent.row.group ?? 'other';
    const siblings = grouped.get(key) ?? [];
    siblings.push(group);
    grouped.set(key, siblings);
  }
  const order = new Map([...groupOrder, 'other'].map((key, index) => [key, index]));
  return [...grouped.entries()]
    .sort(([a], [b]) => (order.get(a) ?? order.size) - (order.get(b) ?? order.size))
    .map(([key, groups]) => {
      const visible = groups.flatMap((group) => [group.parent, ...group.visibleChildren]);
      return { key, section: { category: section.category, groups, visibleTotal: visible.length, visibleOn: visible.filter((node) => node.on).length } };
    });
}


/** Subgroups inside a parent remain visually scoped to that parent. */
export function groupFeatureChildren(
  children: FeatureTreeNode[],
  fallbackGroup: string | undefined,
  groupOrder: readonly string[],
): { key: string; children: FeatureTreeNode[] }[] {
  const grouped = new Map<string, FeatureTreeNode[]>();
  for (const child of children) {
    const key = child.row.group ?? fallbackGroup ?? 'other';
    const siblings = grouped.get(key) ?? [];
    siblings.push(child);
    grouped.set(key, siblings);
  }
  const order = new Map([...groupOrder, 'other'].map((key, index) => [key, index]));
  return [...grouped.entries()]
    .sort(([a], [b]) => (order.get(a) ?? order.size) - (order.get(b) ?? order.size))
    .map(([key, children]) => ({ key, children }));
}
