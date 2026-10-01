import type { loadOrgChartHome } from '../../../../lib/hrm/org-chart-home'
export type OrgChartLabels = NonNullable<Awaited<ReturnType<typeof loadOrgChartHome>>>['labels']
import type { Edge } from '@xyflow/react'
import type { OrgChartLayout } from '@openbooks/engine/hrm/org-chart/contracts'
import type { OrgChartNode } from '@openbooks/engine/hrm/org-chart/contracts'

export const CARD_WIDTH = 244
export const CARD_HEIGHT = 164

export function nodeKey(node: OrgChartNode): string {
  return node.employmentId ?? `vacant:${node.positionId}`
}

export function flattenChart(roots: OrgChartNode[]): OrgChartNode[] {
  const result: OrgChartNode[] = []
  const pending = [...roots].reverse()
  while (pending.length) {
    const node = pending.pop()!
    result.push(node)
    pending.push(...[...node.children].reverse())
  }
  return result
}

export function matchesNode(node: OrgChartNode, query: string, department: string): boolean {
  return (!department || node.department === department) &&
    (!query || [node.name, node.title, node.department, node.positionCode]
      .some((value) => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
}

export function departmentColor(department: string | null): string {
  if (!department) return '#64748b'
  let hash = 0
  for (const character of department) hash = (hash * 31 + character.charCodeAt(0)) % 360
  return `hsl(${hash} 52% 45%)`
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

/** Native reporting edges are derived only when both employees have been manually placed. */
export function chartEdges(graph: OrgChartLayout, roots: OrgChartNode[]): Edge[] {
  const placements = new Map(graph.nodes.filter((node) => node.kind === 'employee').map((node) => [node.referenceId, node.id]))
  const edges: Edge[] = graph.edges.map((edge) => ({ ...edge, id: `layout:${edge.source}:${edge.target}`, data: { canonical: false } }))
  for (const manager of flattenChart(roots)) {
    const source = placements.get(manager.employmentId ?? '')
    for (const employee of manager.children) {
      const target = placements.get(employee.employmentId ?? '')
      if (source && target) edges.push({ id: `reporting:${source}:${target}`, source, target, data: { canonical: true } })
    }
  }
  return edges
}
