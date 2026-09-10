import 'server-only'

import { insightVisibilitySql } from '@/lib/insight-access'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadDashboardEmbed } from '../../../../api/insights/_lib'
import type { DashboardBuilder } from './DashboardBuilder'

/**
 * The insights dashboard builder, split into a loader and a spec.
 *
 * One whole client island: a drag-and-drop board with a card palette, per-card
 * placement state, publish and pin mutations. There is nothing here a spec can
 * decompose, so the spec places one widget over loader-resolved props.
 *
 * Two loader decisions matter more than the rendering and both stay in the
 * loader. `publishedOnly: !canCreate` is a VISIBILITY rule — a reader without
 * `insights.create` must not see draft cards on the board — and the available-
 * card query carries `insightVisibilitySql(authz)`, which fences the palette
 * to what this caller may see. Neither could be expressed in a spec, and
 * neither should be: they are the difference between a dashboard and a leak.
 */

type BuilderProps = Parameters<typeof DashboardBuilder>[0]

export interface InsightsDashboardData {
  dashboard: BuilderProps['dashboard']
  cards: BuilderProps['cards']
  availableCards: BuilderProps['availableCards']
  pinned: boolean
  canCreate: boolean
  canPublish: boolean
}

export async function loadInsightsDashboard(id: string): Promise<InsightsDashboardData> {
  const authz = await requirePermission('insights.read')
  const canCreate = can(authz, 'insights.create')
  const canPublish = can(authz, 'insights.publish')
  const orgId = authz.user.orgId

  if (!isUuid(id)) notFound()

  // Editors see draft cards on the board too (so a WIP card can be placed);
  // otherwise only published cards render.
  const embed = await loadDashboardEmbed(id, orgId, { publishedOnly: !canCreate })
  if (!embed) notFound()

  // Published cards available to drop onto the board.
  const available = (await db.execute(sql`
    select id, name, description, viz_type
      from insight_cards
     where org_id = ${orgId} and status = 'published' and ${insightVisibilitySql(authz)}
     order by name asc
  `)) as any

  const pinned = await db.execute(sql`
    select 1 from insight_dashboard_pins
     where org_id = ${orgId} and user_id = ${authz.user.id} and dashboard_id = ${id}
  `)

  return {
    dashboard: {
      id: embed.dashboard.id,
      name: embed.dashboard.name,
      description: embed.dashboard.description,
      status: embed.dashboard.status,
      updated_at: embed.dashboard.updated_at,
      layout: embed.layout,
    },
    cards: embed.cards,
    availableCards: available.rows,
    pinned: pinned.rows.length > 0,
    canCreate,
    canPublish,
  }
}

export function insightsDashboardSpec(data: InsightsDashboardData): PageSpec {
  return page({
    // The builder owns its own full-height shell; a page layout would nest a
    // second one around it.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('insights-dashboard-builder', {
        dashboard: data.dashboard,
        cards: data.cards,
        availableCards: data.availableCards,
        pinned: data.pinned,
        canCreate: data.canCreate,
        canPublish: data.canPublish,
      }),
    ],
  })
}
