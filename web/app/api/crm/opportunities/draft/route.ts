import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { ensureCrmDefaults, nextOpportunityNumber, promoteCrmAccount } from '@openbooks/engine/src/crm.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const gate = await guardPermission('crm.opportunities.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = await req.json().catch(() => ({})) as { partyId?: string }
  if (body.partyId && !isUuid(body.partyId)) return NextResponse.json({ error: 'invalid account' }, { status: 422 })
  if (body.partyId) {
    const exists = (await db.execute(sql`select 1 from parties where id = ${body.partyId} and org_id = ${user.orgId}`)) as unknown as { rows: unknown[] }
    if (!exists.rows[0]) return NextResponse.json({ error: 'account not found' }, { status: 404 })
  }
  await ensureCrmDefaults(user.orgId, user.id)
  const [number, org] = await Promise.all([
    nextOpportunityNumber(user.orgId),
    db.execute(sql`select base_currency from orgs where id = ${user.orgId}`) as any,
  ])
  const opportunity = await db.transaction(async (tx) => {
    const status = (await tx.execute(sql`
      select id, probability, default_forecast_category from crm_opportunity_statuses
       where org_id = ${user.orgId} and is_default and is_active order by sequence limit 1`)) as unknown as { rows: any[] }
    const s = status.rows[0]!
    const inserted = (await tx.execute(sql`
      insert into crm_opportunities
        (org_id, opportunity_number, title, party_id, owner_user_id, status_id, probability,
         forecast_category, currency, is_active, created_by, updated_by)
      values (${user.orgId}, ${number}, 'New opportunity', ${body.partyId ?? null}, ${user.id}, ${s.id},
              ${s.probability}, ${s.default_forecast_category}, ${org.rows[0]?.base_currency ?? 'CAD'}, false, ${user.id}, ${user.id})
      returning id`)) as unknown as { rows: { id: string }[] }
    if (body.partyId) await promoteCrmAccount(tx, { orgId: user.orgId, partyId: body.partyId, actorId: user.id, toStage: 'prospect', sourceKind: 'opportunity', sourceId: inserted.rows[0]!.id })
    await tx.execute(sql`
      insert into crm_opportunity_stage_events
        (org_id, opportunity_id, to_status_id, probability, forecast_category, reason, created_by, updated_by)
      values (${user.orgId}, ${inserted.rows[0]!.id}, ${s.id}, ${s.probability}, ${s.default_forecast_category},
              'Opportunity created', ${user.id}, ${user.id})`)
    return inserted.rows[0]!
  })
  return NextResponse.json(opportunity)
}
