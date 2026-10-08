import 'server-only'
import { getLocale } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type React from 'react'
import type { DashboardLayoutData } from '@openbooks/schema'
import type { Authz } from '@/lib/authz'
import { insightVisibilitySql } from '@/lib/insight-access'
import { getAuthz, can } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { WIDGETS } from './_widget-registry'
import { AnalyticsWidgetPreview, WidgetCard } from './_widget-views'
import type { AllowedWidgetIds } from './widget-features'
import { loadDashboardMetrics, pruneDashboardMetrics } from './_metrics'
import type { DashboardMetrics } from './_metrics'
import { CardTile, type CardTileData } from '../insights/CardTile'
import type { InsightQuery, VizSettings, VizType } from '@openbooks/analytics'
import { listApps } from '@/lib/apps/store'
import { appKeyFromWidgetId, appWidgetId } from '@/lib/apps/surfaces'
import { AppWidgetCard, type DashboardApp } from './_app-widget'

export type LibraryCard = { id: string; name: string; description: string }

export async function loadDashboardApps(authz: Authz): Promise<DashboardApp[]> {
  if (!can(authz, 'apps.use')) return []
  const apps = await listApps(authz.user.orgId)
  return apps
    .filter((app) => app.status === 'installed' && app.activeVersionId)
    .map((app) => ({
      key: app.key,
      name: app.name,
      description: app.description ?? '',
      iconKey: app.iconKey,
    }))
}

function appWidgetNodes(apps: DashboardApp[], widgetIds?: readonly string[]): Record<string, React.ReactNode> {
  const requested = widgetIds ? new Set(widgetIds.map(appKeyFromWidgetId).filter((key): key is string => !!key)) : null
  return Object.fromEntries(
    apps
      .filter((app) => !requested || requested.has(app.key))
      .map((app) => [appWidgetId(app.key), <AppWidgetCard key={app.key} app={app} />]),
  )
}

export async function loadPublishedInsightCards(orgId: string): Promise<LibraryCard[]> {
  const authz = await getAuthz()
  if (!authz || authz.user.orgId !== orgId) return []
  const res = ((await db.execute(sql`
    select id, name, coalesce(description, '') as description
      from insight_cards
     where org_id = ${orgId} and status = 'published' and ${insightVisibilitySql(authz)}
     order by name asc
  `)))
  return res.rows as LibraryCard[]
}

async function loadInsightCardNodes(
  authz: Authz,
  widgetIds: string[],
): Promise<Record<string, React.ReactNode>> {
  const orgId = authz.user.orgId
  const uuidIds = widgetIds.filter((id) => isUuid(id))
  if (uuidIds.length === 0) return {}
  const res = await db.execute<{
    id: string
    name: string
    description: string | null
    query: InsightQuery
    viz_type: VizType
    viz_settings: VizSettings
  }>(sql`
    select id, name, description, query, viz_type, viz_settings
      from insight_cards
     where org_id = ${orgId} and id = any(${`{${uuidIds.join(',')}}`}::uuid[])
       and status = 'published' and ${insightVisibilitySql(authz)}
  `)
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
  /**
   * REQUIRED: the entry boundary's resolved set (view slot), carrying both
   * the permission decision and the feature gates. The canvas never resolves
   * features itself, so layout prune, node selection, and metric selection
   * below all enforce the same ids the slot filtered on. Non-registry
   * insight-card UUIDs and app tiles keep resolving through canSeeWidget.
   */
  allowedWidgetIds: AllowedWidgetIds,
): Promise<{ nodes: Record<string, React.ReactNode> }> {
  // The layout arriving here is already filtered by the slot on this same
  // set, but the allowedWidgetIds check below is the enforcement point —
  // derive the loader's query set from exactly the ids that survive it, so
  // a denied widget's reader never runs.
  const visibleIds = layout.widgets.map((w) => w.id).filter((id) => id in WIDGETS && allowedWidgetIds.has(id))
  // Week labels on the forecast chart localize to the request locale — the
  // position reader defaults to en-US without one.
  const locale = await getLocale()
  const [metrics, cardNodes, apps] = await Promise.all([
    loadDashboardMetrics(authz, visibleIds, undefined, locale),
    loadInsightCardNodes(authz, layout.widgets.map((w) => w.id)),
    layout.widgets.some(widget => appKeyFromWidgetId(widget.id)) ? loadDashboardApps(authz) : Promise.resolve([]),
  ])

  const nodes: Record<string, React.ReactNode> = {}
  for (const w of layout.widgets) {
    if (w.id in WIDGETS && allowedWidgetIds.has(w.id)) {
      // Each widget card is a client component: hand it only the metric
      // fields it renders, never the whole org-wide metrics object.
      nodes[w.id] = (
        <WidgetCard
          key={w.id}
          widgetId={w.id}
          data={pruneDashboardMetrics(metrics, [w.id])}
        />
      )
    }
  }
  Object.assign(nodes, cardNodes)
  Object.assign(nodes, appWidgetNodes(apps, layout.widgets.map((widget) => widget.id)))
  return { nodes }
}

export async function loadDashboardEditCanvas(
  authz: Authz,
  layout: DashboardLayoutData,
  opts: {
    /**
     * REQUIRED: the entry boundary's resolved set (edit slot), carrying both
     * the permission decision and the feature gates. The canvas never
     * resolves features itself and never falls back to permission-only for
     * registry ids: an id absent from this set renders no preview node and
     * feeds no metric reader.
     */
    allowedWidgetIds: AllowedWidgetIds
  },
): Promise<{
  nodes: Record<string, React.ReactNode>
  libraryCards: LibraryCard[]
  apps: DashboardApp[]
}> {
  const widgetAllowed = (id: string) => opts.allowedWidgetIds.has(id)
  const canUseInsights = can(authz, 'insights.read')

  // Widgets extracted from Analytics dashboards run that dashboard's loaders.
  // Placed ones preview live; the rest of the palette shows a named
  // placeholder until the layout is saved, so opening the editor never runs
  // every dashboard's computation just to fill the gallery.
  const placed = new Set(layout.widgets.map((w) => w.id))
  const previewIds = Object.keys(WIDGETS).filter((id) => widgetAllowed(id) && (!WIDGETS[id]!.analyticsSource || placed.has(id)))
  const previewSet = new Set(previewIds)
  const previewLocale = await getLocale()
  const [data, libraryCards, placedCardNodes, apps] = await Promise.all([
    loadDashboardMetrics(authz, previewIds, undefined, previewLocale),
    canUseInsights ? loadPublishedInsightCards(authz.user.orgId) : Promise.resolve([] as LibraryCard[]),
    loadInsightCardNodes(
      authz,
      layout.widgets.filter((w) => isUuid(w.id)).map((w) => w.id),
    ),
    loadDashboardApps(authz),
  ])

  const nodes: Record<string, React.ReactNode> = {}
  for (const id of Object.keys(WIDGETS)) {
    if (!widgetAllowed(id)) continue
    if (!previewSet.has(id)) {
      nodes[id] = <AnalyticsWidgetPreview key={id} widgetId={id} />
      continue
    }
    nodes[id] = (
      <WidgetCard
        key={id}
        widgetId={id}
        data={pruneDashboardMetrics(data, [id])}
      />
    )
  }
  Object.assign(nodes, placedCardNodes)
  Object.assign(nodes, appWidgetNodes(apps))

  return { nodes, libraryCards, apps }
}

export type { DashboardMetrics }
