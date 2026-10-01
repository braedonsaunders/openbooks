import { z } from 'zod'

const coordinate = z.number().finite().min(-100000).max(100000)
const node = z.object({
  id: z.string().uuid(),
  kind: z.enum(['employee', 'vacancy', 'department', 'team', 'role']),
  referenceId: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(200).optional(),
  position: z.object({ x: coordinate, y: coordinate }).strict(),
}).strict().superRefine((value, ctx) => {
  const referenced = value.kind === 'employee' || value.kind === 'vacancy'
  if (referenced && !value.referenceId) ctx.addIssue({ code: 'custom', message: 'Choose an employee or open position from the sidebar.' })
  if (!referenced && !value.label) ctx.addIssue({ code: 'custom', message: 'Name the department, team or role placeholder.' })
  if (referenced && (value.label !== undefined || value.note !== undefined)) ctx.addIssue({ code: 'custom', message: 'Employee and position details must come from their native records.' })
  if (!referenced && value.referenceId !== undefined) ctx.addIssue({ code: 'custom', message: 'A placeholder cannot refer to an employee record.' })
})

/** Presentation-only diagram; its connectors never mutate employment reporting lines. */
export const orgChartLayoutSchema = z.object({
  nodes: z.array(node).max(500),
  edges: z.array(z.object({ source: z.string().uuid(), target: z.string().uuid() }).strict()).max(500),
}).strict().superRefine((layout, ctx) => {
  const ids = new Set<string>()
  const references = new Set<string>()
  for (const item of layout.nodes) {
    if (ids.has(item.id)) ctx.addIssue({ code: 'custom', message: 'Each chart card needs a unique identifier.' })
    ids.add(item.id)
    if (item.referenceId) {
      const key = `${item.kind}:${item.referenceId}`
      if (references.has(key)) ctx.addIssue({ code: 'custom', message: 'Each employee or open position may appear only once on the chart.' })
      references.add(key)
    }
  }
  const parents = new Map<string, string>()
  for (const edge of layout.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) ctx.addIssue({ code: 'custom', message: 'Connect only cards that are on the chart.' })
    if (parents.has(edge.target)) ctx.addIssue({ code: 'custom', message: 'Each card may have one parent. Remove its existing connection first.' })
    parents.set(edge.target, edge.source)
  }
  for (const id of ids) {
    const seen = new Set<string>()
    let next: string | undefined = id
    while (next !== undefined) {
      if (seen.has(next)) { ctx.addIssue({ code: 'custom', message: 'A chart connection cannot create a cycle. Choose a parent outside this branch.' }); break }
      seen.add(next)
      next = parents.get(next)
    }
  }
})
export type OrgChartLayout = z.infer<typeof orgChartLayoutSchema>
export type OrgChartLayoutNode = OrgChartLayout['nodes'][number]
export interface SavedOrgChartLayout { revision: number; graph: OrgChartLayout }
export const EMPTY_ORG_CHART_LAYOUT: SavedOrgChartLayout = { revision: 0, graph: { nodes: [], edges: [] } }

export const saveOrgChartLayoutSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2147483646),
  graph: orgChartLayoutSchema,
}).strict()
