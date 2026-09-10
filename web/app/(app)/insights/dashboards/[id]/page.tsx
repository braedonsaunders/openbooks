import { insightVisibilitySql } from '@/lib/insight-access'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, requirePermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadDashboardEmbed } from '../../../../api/insights/_lib'
import { DashboardBuilder } from './DashboardBuilder'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { insightsDashboardSpec, loadInsightsDashboard } from './view'

export const dynamic = 'force-dynamic'

export default async function DashboardDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  if (sp.__viewspec === '1') {
    const { id } = await params
    const data = await loadInsightsDashboard(id)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={insightsDashboardSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }

  const authz = await requirePermission('insights.read')
  const canCreate = can(authz, 'insights.create')
  const canPublish = can(authz, 'insights.publish')
  const orgId = authz.user.orgId

  const { id } = await params
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

  const pinned = ((await db.execute(sql`
    select 1 from insight_dashboard_pins
     where org_id = ${orgId} and user_id = ${authz.user.id} and dashboard_id = ${id}
  `)))

  return (
    <DashboardBuilder
      dashboard={{
        id: embed.dashboard.id,
        name: embed.dashboard.name,
        description: embed.dashboard.description,
        status: embed.dashboard.status,
        updated_at: embed.dashboard.updated_at,
        layout: embed.layout,
      }}
      cards={embed.cards}
      availableCards={available.rows}
      pinned={pinned.rows.length > 0}
      canCreate={canCreate}
      canPublish={canPublish}
    />
  )
}
