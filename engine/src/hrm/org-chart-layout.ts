import { sql } from 'drizzle-orm'
import { withOrgTransaction } from '../platform/db.ts'
import { actorAllowedSubsidiaryIds } from '../organization/actor-subsidiaries.ts'
import { actorHasPermission } from '../organization/actor-permissions.ts'
import { UnrestrictedScopeError } from '../organization/subsidiary-scope.ts'
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { HrmAuthorizationError, requireHrmEmploymentManage } from './authorization.ts'
import { HrmOrgChartError } from './documents/errors.ts'
import { loadOrgChart, type OrgChartNode } from './org-chart.ts'
import { EMPTY_ORG_CHART_LAYOUT, orgChartLayoutSchema, saveOrgChartLayoutSchema, type SavedOrgChartLayout } from './org-chart-layout-schema.ts'

function savedLayout(value: unknown): SavedOrgChartLayout {
  if (value === null || value === undefined) return structuredClone(EMPTY_ORG_CHART_LAYOUT)
  const saved = value as SavedOrgChartLayout
  const parsed = orgChartLayoutSchema.safeParse(saved.graph)
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 1 || !parsed.success) throw new HrmOrgChartError('REFUSED', 'The saved chart layout is invalid. Restore a valid layout from the organization audit history before editing.')
  return { revision: saved.revision, graph: parsed.data }
}

/** Resolve native people and prune the diagram through the same legal-entity and self-service scope. */
export async function loadOrgChartWorkspace(input: { orgId: string; actorId: string; asOf: string }) {
  return withOrgTransaction(input.orgId, async (tx) => {
    if (!await lockAndCheckOrgFeature(tx, input.orgId, 'hrm')) throw new HrmOrgChartError('REFUSED', 'Enable Human resources in Company Settings → Features to open the org chart.')
    const chart = await loadOrgChart(input)
    const row = (await tx.execute<{ layout: unknown }>(sql`select settings->'hrmOrgChartLayout' as layout from orgs where id = ${input.orgId}`)).rows[0]
    if (!row) throw new HrmOrgChartError('NOT_FOUND', 'The organization is unavailable.')
    const saved = savedLayout(row.layout)
    const visible = new Set<string>()
    const visit = (nodes: OrgChartNode[]) => {
      for (const node of nodes) {
        if (node.employmentId) visible.add(`employee:${node.employmentId}`)
        if (node.vacant && node.positionId) visible.add(`vacancy:${node.positionId}`)
        visit(node.children)
      }
    }
    visit(chart.roots)
    const unrestricted = await actorAllowedSubsidiaryIds(tx, input.orgId, input.actorId) === null
    const canReadAll = unrestricted && await actorHasPermission(tx, input.orgId, input.actorId, 'hrm.employment.read')
    const nodes = saved.graph.nodes.filter((node) => node.referenceId ? visible.has(`${node.kind}:${node.referenceId}`) : canReadAll)
    const ids = new Set(nodes.map((node) => node.id))
    return { chart, layout: { revision: saved.revision, graph: { nodes, edges: saved.graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) } } }
  })
}

export async function saveOrgChartLayout(input: { orgId: string; actorId: string; expectedRevision: number; graph: unknown }): Promise<SavedOrgChartLayout> {
  const parsed = saveOrgChartLayoutSchema.safeParse({ expectedRevision: input.expectedRevision, graph: input.graph })
  if (!parsed.success) throw new HrmOrgChartError('VALIDATION', parsed.error.issues.map((issue) => issue.message).join(' '))
  return withOrgTransaction(input.orgId, async (tx) => {
    await requireHrmEmploymentManage(tx, input.orgId, input.actorId)
    if (!await actorHasPermission(tx, input.orgId, input.actorId, 'hrm.employment.read')) throw new HrmAuthorizationError('Org chart layout editing requires hrm.employment.read. Ask an administrator to grant it in /admin/roles.')
    if (await actorAllowedSubsidiaryIds(tx, input.orgId, input.actorId) !== null) throw new UnrestrictedScopeError()
    // The org row serializes layout revisions and feature changes; lock it exclusively before the shared feature check.
    const row = (await tx.execute<{ layout: unknown }>(sql`select settings->'hrmOrgChartLayout' as layout from orgs where id = ${input.orgId} for update`)).rows[0]
    if (!row) throw new HrmOrgChartError('NOT_FOUND', 'The organization is unavailable.')
    if (!await lockAndCheckOrgFeature(tx, input.orgId, 'hrm')) throw new HrmOrgChartError('REFUSED', 'Enable Human resources in Company Settings → Features before saving the org chart.')
    const before = savedLayout(row.layout)
    if (before.revision !== parsed.data.expectedRevision) throw new HrmOrgChartError('REFUSED', 'The chart was changed by another editor. Reload the page to review the latest layout before saving. Your unsaved layout has been kept open.')
    for (const node of parsed.data.graph.nodes) {
      if (!node.referenceId) continue
      const found = node.kind === 'employee'
        ? (await tx.execute(sql`select id from worker_employments where org_id = ${input.orgId} and id = ${node.referenceId}`)).rows.length
        : (await tx.execute(sql`select id from positions where org_id = ${input.orgId} and id = ${node.referenceId}`)).rows.length
      if (found !== 1) throw new HrmOrgChartError('VALIDATION', 'A chart card refers to an unavailable employee or position. Remove that card and choose a record from the sidebar.')
    }
    const after = { revision: before.revision + 1, graph: parsed.data.graph }
    const updated = await tx.execute(sql`update orgs set settings = jsonb_set(settings, '{hrmOrgChartLayout}', ${JSON.stringify(after)}::jsonb, true), updated_at = now() where id = ${input.orgId} returning id`)
    if (updated.rows.length !== 1) throw new HrmOrgChartError('REFUSED', 'The chart could not be saved. Reload the page and try again.')
    await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id) values (${input.orgId}, 'orgs', ${input.orgId}, 'org_chart_layout_saved', ${JSON.stringify({ before, after })}::jsonb, ${input.actorId})`)
    return after
  })
}
