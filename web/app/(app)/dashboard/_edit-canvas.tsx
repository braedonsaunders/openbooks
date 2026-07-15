import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type React from 'react'
import type { DashboardLayoutData } from '@openbooks/schema'
import type { Authz } from '@/lib/authz'
import { can } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { WIDGETS } from './_widget-registry'
import { canSeeWidget } from './_widget-access'
import { WidgetCard } from './_widget-views'
import { loadDashboardMetrics, pruneDashboardMetrics } from './_metrics'
import type { DashboardMetrics } from './_metrics'
import { CardTile, type CardTileData } from '../insights/CardTile'

export type LibraryCard = { id: string; name: string; description: string }

export async function loadPublishedInsightCards(orgId: string): Promise<LibraryCard[]> {
  const res = (await db.execute(sql`
    select id, name, coalesce(description, '') as description
      from insight_cards
     where org_id = ${orgId} and status = 'published'
     order by name asc
  `)) as any
  return res.rows as LibraryCard[]
}

async function loadInsightCardNodes(
  orgId: string,
  widgetIds: string[],
): Promise<Record<string, React.ReactNode>> {
  const uuidIds = widgetIds.filter((id) => isUuid(id))
  if (uuidIds.length === 0) return {}
  const res = (await db.execute(sql`
    select id, name, description, query, viz_type, viz_settings
      from insight_cards
     where org_id = ${orgId} and id = any(${sql.param(uuidIds)})
       and status = 'published'
  `)) as any
  const nodes: Record<string, React.ReactNode> = {}
  for (const row of res.rows) {
    const data: CardTileData = {
      id: row.id,
      name: row.name,
      description: row.description,
      query: row.query,
      vizType: row.viz_type,
      vizSettings: row.viz_settings ?? {},
    }
    nodes[row.id] = <CardTile key={row.id} card={data} />
  }
  return nodes
}

export async function loadDashboardView(
  authz: Authz,
  layout: DashboardLayoutData,
): Promise<{ nodes: Record<string, React.ReactNode>; data: DashboardMetrics }> {
  const [metrics, cardNodes] = await Promise.all([
    loadDashboardMetrics(authz),
    loadInsightCardNodes(authz.user.orgId, layout.widgets.map((w) => w.id)),
  ])

  const nodes: Record<string, React.ReactNode> = {}
  for (const w of layout.widgets) {
    if (w.id in WIDGETS && canSeeWidget(authz, w.id)) {
      // Each widget card is a client component: hand it only the metric
      // fields it renders, never the whole org-wide metrics object.
      nodes[w.id] = (
        <WidgetCard
          key={w.id}
          widgetId={w.id}
          data={pruneDashboardMetrics(metrics, [w.id])}
          quickActions={layout.quickActions}
        />
      )
    }
  }
  Object.assign(nodes, cardNodes)
  return { nodes, data: metrics }
}

export async function loadDashboardEditCanvas(
  authz: Authz,
  layout: DashboardLayoutData,
  opts: {
    allowedWidgetIds?: ReadonlySet<string>
  } = {},
): Promise<{
  nodes: Record<string, React.ReactNode>
  libraryCards: LibraryCard[]
}> {
  const widgetAllowed = (id: string) => !opts.allowedWidgetIds || opts.allowedWidgetIds.has(id)
  const canUseInsights = can(authz, 'insights.read')

  const [data, libraryCards, placedCardNodes] = await Promise.all([
    loadDashboardMetrics(authz),
    canUseInsights ? loadPublishedInsightCards(authz.user.orgId) : Promise.resolve([] as LibraryCard[]),
    loadInsightCardNodes(
      authz.user.orgId,
      layout.widgets.filter((w) => isUuid(w.id)).map((w) => w.id),
    ),
  ])

  const nodes: Record<string, React.ReactNode> = {}
  for (const id of Object.keys(WIDGETS)) {
    if (!widgetAllowed(id) || !canSeeWidget(authz, id)) continue
    nodes[id] = (
      <WidgetCard
        key={id}
        widgetId={id}
        data={pruneDashboardMetrics(data, [id])}
        quickActions={layout.quickActions}
      />
    )
  }
  Object.assign(nodes, placedCardNodes)

  return { nodes, libraryCards }
}

export type { DashboardMetrics }
