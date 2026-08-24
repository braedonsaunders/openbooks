import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, requirePermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadDashboardEmbed } from '../../../../api/insights/_lib'
import { DashboardBuilder } from './DashboardBuilder'

export const dynamic = 'force-dynamic'

export default async function DashboardDetail({ params }: { params: Promise<{ id: string }> }) {
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
     where org_id = ${orgId} and status = 'published'
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
