import type { OrgChartNode } from '@openbooks/engine/hrm/org-chart/contracts'

export const CARD_WIDTH = 244
export const CARD_HEIGHT = 164
const HORIZONTAL_GAP = 36
const VERTICAL_GAP = 76

export function nodeKey(node: OrgChartNode): string {
  return node.employmentId ?? `vacant:${node.positionId}`
}

export function flattenChart(roots: OrgChartNode[]): OrgChartNode[] {
  return roots.flatMap((node) => [node, ...flattenChart(node.children)])
}

export function matchesNode(node: OrgChartNode, query: string, department: string): boolean {
  return (!department || node.department === department) &&
    (!query || [node.name, node.title, node.department, node.positionCode]
      .some((value) => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
}

/** Keep ancestors of matches so filtering never invents a reporting line. */
export function chartVisibility(roots: OrgChartNode[], query: string, department: string) {
  const matches = new Set<string>()
  const ancestors = new Set<string>()
  const visit = (node: OrgChartNode): boolean => {
    const matched = matchesNode(node, query, department)
    if (matched) matches.add(nodeKey(node))
    const childMatches = node.children.map(visit).some(Boolean)
    if (childMatches) ancestors.add(nodeKey(node))
    return matched || childMatches
  }
  roots.forEach(visit)
  return { matches, ancestors }
}

export function departmentColor(department: string | null): string {
  if (!department) return '#64748b'
  let hash = 0
  for (const character of department) hash = (hash * 31 + character.charCodeAt(0)) % 360
  return `hsl(${hash} 52% 45%)`
}

export interface ChartPlacement {
  id: string
  person: OrgChartNode
  position: { x: number; y: number }
  collapsed: boolean
  highlighted: boolean
  context: boolean
}

/** Subtree widths reserve space for every visible descendant at every level. */
export function layoutChart(
  roots: OrgChartNode[],
  collapsed: ReadonlySet<string>,
  query = '',
  department = '',
) {
  const filtering = Boolean(query || department)
  const { matches, ancestors } = chartVisibility(roots, query, department)
  const widths = new Map<string, number>()
  const children = new Map<string, OrgChartNode[]>()
  const visible = (node: OrgChartNode) => !filtering || matches.has(nodeKey(node)) || ancestors.has(nodeKey(node))
  function measure(node: OrgChartNode): number {
    const key = nodeKey(node)
    const shown = collapsed.has(key) && !ancestors.has(key) ? [] : node.children.filter(visible)
    children.set(key, shown)
    const width = Math.max(CARD_WIDTH, shown.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, shown.length - 1) * HORIZONTAL_GAP)
    widths.set(key, width)
    return width
  }
  const shownRoots = roots.filter(visible)
  shownRoots.forEach(measure)
  const nodes: ChartPlacement[] = []
  const edges: { id: string; source: string; target: string }[] = []
  function place(node: OrgChartNode, left: number, depth: number) {
    const id = nodeKey(node)
    const width = widths.get(id)!
    const shown = children.get(id)!
    nodes.push({ id, person: node, position: { x: left + (width - CARD_WIDTH) / 2, y: depth * (CARD_HEIGHT + VERTICAL_GAP) },
      collapsed: node.children.length > 0 && shown.length === 0, highlighted: filtering && matches.has(id), context: filtering && !matches.has(id) })
    const total = shown.reduce((sum, child) => sum + widths.get(nodeKey(child))!, 0) + Math.max(0, shown.length - 1) * HORIZONTAL_GAP
    let nextLeft = left + (width - total) / 2
    for (const child of shown) {
      const target = nodeKey(child)
      edges.push({ id: `${id}:${target}`, source: id, target })
      place(child, nextLeft, depth + 1)
      nextLeft += widths.get(target)! + HORIZONTAL_GAP
    }
  }
  let left = 0
  for (const root of shownRoots) {
    place(root, left, 0)
    left += widths.get(nodeKey(root))! + HORIZONTAL_GAP * 2
  }
  return { nodes, edges, matches }
}

/** A manager must not be the employee or any descendant of that employee. */
export function canConnectManager(roots: OrgChartNode[], managerId: string, employeeId: string): boolean {
  const flat = flattenChart(roots)
  const employee = flat.find((node) => node.employmentId === employeeId)
  const manager = flat.find((node) => node.employmentId === managerId)
  if (!employee || !manager || managerId === employeeId) return false
  return !flattenChart(employee.children).some((node) => node.employmentId === managerId) &&
    !manager.children.some((node) => node.employmentId === employeeId)
}
