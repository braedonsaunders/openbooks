import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { promoteCrmAccount } from '@openbooks/engine/src/crm.ts'
import { computeOpportunityTotals, validateContributionTotal } from '@openbooks/engine/src/crm-math.ts'
import { guardPermission } from '../../../../../lib/authz'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../../lib/features'
import { isUuid } from '../../../../../lib/list-params'
import { loadOpportunity } from '../../../../../lib/crm'
import { canonicalDecimal, compareDecimal } from '../../../../../lib/exact-decimal'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'

export const runtime = 'nodejs'

const CATEGORIES = ['omitted', 'worst_case', 'most_likely', 'upside']

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function orgUuidExists(table: 'parties' | 'contacts' | 'users' | 'crm_sales_teams' | 'crm_lead_sources', id: string | null, orgId: string): Promise<boolean> {
  if (!id) return true
  if (!isUuid(id)) return false
  const result = table === 'parties'
    ? await db.execute(sql`select 1 from parties where id = ${id} and org_id = ${orgId}`)
    : table === 'contacts'
      ? await db.execute(sql`select 1 from contacts where id = ${id} and org_id = ${orgId}`)
      : table === 'users'
        ? await db.execute(sql`select 1 from users where id = ${id} and org_id = ${orgId}`)
        : table === 'crm_sales_teams'
          ? await db.execute(sql`select 1 from crm_sales_teams where id = ${id} and org_id = ${orgId} and is_active`)
          : await db.execute(sql`select 1 from crm_lead_sources where id = ${id} and org_id = ${orgId} and is_active`)
  return (result as unknown as { rows: unknown[] }).rows.length === 1
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.opportunities.read', 'crm')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const opportunity = isUuid(id) ? await loadOpportunity(id, gate.user.orgId) : null
  return opportunity ? NextResponse.json(opportunity) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.opportunities.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const existing = (await db.execute<any>(sql`
    select o.*, s.is_closed, s.is_won from crm_opportunities o
    join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
    where o.id = ${id} and o.org_id = ${user.orgId}`))
  const current = existing.rows[0]
  if (!current) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json() as Record<string, any>
  const partyId = body.partyId === undefined ? current.party_id : textOrNull(body.partyId)
  const contactId = body.primaryContactId === undefined ? current.primary_contact_id : textOrNull(body.primaryContactId)
  const ownerUserId = body.ownerUserId === undefined ? current.owner_user_id : textOrNull(body.ownerUserId)
  const salesTeamId = body.salesTeamId === undefined ? current.sales_team_id : textOrNull(body.salesTeamId)
  const leadSourceId = body.leadSourceId === undefined ? current.lead_source_id : textOrNull(body.leadSourceId)
  if (!await orgUuidExists('parties', partyId, user.orgId)) return NextResponse.json({ error: 'invalid account' }, { status: 422 })
  if (!await orgUuidExists('contacts', contactId, user.orgId)) return NextResponse.json({ error: 'invalid contact' }, { status: 422 })
  if (contactId && !(await db.execute(sql`select 1 from contacts where id = ${contactId} and party_id = ${partyId} and org_id = ${user.orgId}`) as any).rows[0]) return NextResponse.json({ error: 'contact does not belong to the account' }, { status: 422 })
  if (!await orgUuidExists('users', ownerUserId, user.orgId)) return NextResponse.json({ error: 'invalid owner' }, { status: 422 })
  if (!await orgUuidExists('crm_sales_teams', salesTeamId, user.orgId)) return NextResponse.json({ error: 'invalid sales team' }, { status: 422 })
  if (!await orgUuidExists('crm_lead_sources', leadSourceId, user.orgId)) return NextResponse.json({ error: 'invalid lead source' }, { status: 422 })

  const statusId = body.statusId === undefined ? current.status_id : textOrNull(body.statusId)
  if (!statusId || !isUuid(statusId)) return NextResponse.json({ error: 'status is required' }, { status: 422 })
  const status = (await db.execute<any>(sql`
    select * from crm_opportunity_statuses where id = ${statusId} and org_id = ${user.orgId} and is_active`))
  const nextStatus = status.rows[0]
  if (!nextStatus) return NextResponse.json({ error: 'invalid status' }, { status: 422 })
  if (nextStatus.is_closed) {
    const closeGate = await guardPermission('crm.opportunities.close')
    if (closeGate instanceof NextResponse) return closeGate
  }
  const probability = body.probability === undefined
    ? statusId !== current.status_id ? Number(nextStatus.probability) : Number(current.probability)
    : Number(body.probability)
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) return NextResponse.json({ error: 'probability must be from 0 to 100' }, { status: 422 })
  const category = body.forecastCategory ?? (statusId !== current.status_id ? nextStatus.default_forecast_category : current.forecast_category)
  if (!CATEGORIES.includes(category)) return NextResponse.json({ error: 'invalid forecast category' }, { status: 422 })
  const title = body.title === undefined ? current.title : textOrNull(body.title)
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 422 })
  if (body.currency !== undefined && !(await isFeatureEnabled(user.orgId, 'multiCurrency'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const currency = body.currency === undefined ? current.currency : String(body.currency).toUpperCase()
  if (!(await db.execute(sql`select 1 from currencies where code = ${currency}`) as any).rows[0]) return NextResponse.json({ error: 'invalid currency' }, { status: 422 })
  const winLossReason = body.winLossReason === undefined ? current.win_loss_reason : textOrNull(body.winLossReason)
  if (nextStatus.is_closed && !nextStatus.is_won && !winLossReason) return NextResponse.json({ error: 'a loss reason is required' }, { status: 422 })
  const lines = body.lines as Array<any> | undefined
  let calculated: ReturnType<typeof computeOpportunityTotals> | null = null
  if (lines) {
    if (!Array.isArray(lines)) return NextResponse.json({ error: 'lines must be an array' }, { status: 422 })
    try {
      calculated = computeOpportunityTotals(lines.map((line) => {
        const quantity = canonicalDecimal(line.quantity, 4)
        const unitPrice = canonicalDecimal(line.unitPrice, 4)
        if (quantity === null || unitPrice === null) throw new Error('invalid lines')
        return {
          quantity,
          unitPrice: normalizeMoney(unitPrice),
          probability: line.probability == null ? null : Number(line.probability),
        }
      }), probability)
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'invalid lines' }, { status: 422 })
    }
    for (const line of lines) {
      if (!line.itemId || !isUuid(line.itemId) || !(await db.execute(sql`select 1 from items where id = ${line.itemId} and org_id = ${user.orgId} and is_active`) as any).rows[0]) return NextResponse.json({ error: 'a valid item is required for every line' }, { status: 422 })
    }
  }
  const team = body.team as Array<{ userId: string; contributionPercent: string; isPrimary?: boolean }> | undefined
  const teamRows: Array<{ userId: string; contributionPercent: string; isPrimary?: boolean }> = []
  if (team) {
    if (!Array.isArray(team)) return NextResponse.json({ error: 'team must be an array' }, { status: 422 })
    for (const member of team) {
      const contribution = canonicalDecimal(member.contributionPercent, 4)
      if (contribution === null) return NextResponse.json({ error: 'invalid sales-team contribution' }, { status: 422 })
      teamRows.push({ ...member, contributionPercent: normalizeMoney(contribution) })
    }
    try { validateContributionTotal(teamRows.map((member) => member.contributionPercent)) } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 422 }) }
    if (teamRows.filter((member) => member.isPrimary).length !== 1) return NextResponse.json({ error: 'exactly one team member must be primary' }, { status: 422 })
    for (const member of teamRows) if (!await orgUuidExists('users', member.userId, user.orgId)) return NextResponse.json({ error: 'invalid sales team member' }, { status: 422 })
  }
  const rangeMoney = (raw: unknown) => {
    if (raw == null || raw === '') return null
    const exact = canonicalDecimal(raw, 4)
    if (exact === null || compareDecimal(exact, '0') < 0) return 'invalid'
    return normalizeMoney(exact)
  }
  const rangeLow = body.rangeLow !== undefined ? rangeMoney(body.rangeLow) : undefined
  const rangeHigh = body.rangeHigh !== undefined ? rangeMoney(body.rangeHigh) : undefined
  if (rangeLow === 'invalid' || rangeHigh === 'invalid') return NextResponse.json({ error: 'range must be a non-negative amount' }, { status: 422 })

  await db.transaction(async (tx) => {
    if (lines && calculated) {
      await tx.execute(sql`delete from crm_opportunity_lines where opportunity_id = ${id} and org_id = ${user.orgId}`)
      for (let index = 0; index < lines.length; index++) {
        const input = lines[index]!
        const math = calculated.lines[index]!
        await tx.execute(sql`
          insert into crm_opportunity_lines
            (org_id, opportunity_id, line_number, item_id, description, quantity, unit, unit_price,
             amount, probability, expected_amount, created_by, updated_by)
          values (${user.orgId}, ${id}, ${index + 1}, ${input.itemId ?? null}, ${textOrNull(input.description)},
                  ${math.quantity}, ${textOrNull(input.unit)}, ${math.unitPrice}, ${math.amount}, ${math.probability},
                  ${math.expectedAmount}, ${user.id}, ${user.id})`)
      }
    }
    if (teamRows.length) {
      await tx.execute(sql`delete from crm_opportunity_team_members where opportunity_id = ${id} and org_id = ${user.orgId}`)
      for (const member of teamRows) await tx.execute(sql`
        insert into crm_opportunity_team_members
          (org_id, opportunity_id, user_id, contribution_percent, is_primary, created_by, updated_by)
        values (${user.orgId}, ${id}, ${member.userId}, ${member.contributionPercent}, ${member.isPrimary === true}, ${user.id}, ${user.id})`)
    }
    const projected = calculated?.projectedAmount ?? current.projected_amount
    const weighted = calculated?.weightedAmount ?? (probability !== Number(current.probability)
      ? computeOpportunityTotals([{ quantity: '1', unitPrice: String(current.projected_amount) }], probability).weightedAmount
      : current.weighted_amount)
        await tx.execute(sql`
      update crm_opportunities set
        title = ${title}, party_id = ${partyId}, primary_contact_id = ${contactId}, owner_user_id = ${ownerUserId},
        sales_team_id = ${salesTeamId}, status_id = ${statusId}, lead_source_id = ${leadSourceId},
        expected_close_date = ${body.expectedCloseDate !== undefined ? textOrNull(body.expectedCloseDate) : sql`expected_close_date`},
        forecast_category = ${category}, probability = ${probability},
        currency = ${currency},
        projected_amount = ${projected}, weighted_amount = ${weighted},
        range_low = ${rangeLow !== undefined ? rangeLow : sql`range_low`},
        range_high = ${rangeHigh !== undefined ? rangeHigh : sql`range_high`},
        next_step = ${body.nextStep !== undefined ? textOrNull(body.nextStep) : sql`next_step`},
        competitor_notes = ${body.competitorNotes !== undefined ? textOrNull(body.competitorNotes) : sql`competitor_notes`},
        win_loss_reason = ${winLossReason}, description = ${body.description !== undefined ? textOrNull(body.description) : sql`description`},
        closed_at = case when ${nextStatus.is_closed} then coalesce(closed_at, now()) else null end,
        is_active = ${body.isActive !== undefined ? body.isActive === true : (title !== 'New opportunity' && !!partyId)},
        updated_at = now(), updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId}`)
    if (statusId !== current.status_id || probability !== Number(current.probability) || category !== current.forecast_category) {
      await tx.execute(sql`
        insert into crm_opportunity_stage_events
          (org_id, opportunity_id, from_status_id, to_status_id, probability, forecast_category, reason, created_by, updated_by)
        values (${user.orgId}, ${id}, ${current.status_id}, ${statusId}, ${probability}, ${category},
                ${textOrNull(body.stageReason)}, ${user.id}, ${user.id})`)
    }
    if (partyId) {
      await promoteCrmAccount(tx, { orgId: user.orgId, partyId, actorId: user.id, toStage: nextStatus.is_won ? 'customer' : 'prospect', sourceKind: 'opportunity', sourceId: id, reason: textOrNull(body.stageReason) })
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'crm_opportunities', ${id}, 'update', ${JSON.stringify({ before: current, requested: body })}::jsonb, ${user.id})`)
  })
  return NextResponse.json(await loadOpportunity(id, user.orgId))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.opportunities.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const linked = (await db.execute(sql`select 1 from crm_opportunity_documents where opportunity_id = ${id} and org_id = ${gate.user.orgId} limit 1`))
  if (linked.rows[0]) return NextResponse.json({ error: 'An opportunity with linked sales documents cannot be deleted; close it instead' }, { status: 422 })
  const deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`delete from crm_opportunity_team_members where opportunity_id = ${id} and org_id = ${gate.user.orgId}`)
    await tx.execute(sql`delete from crm_opportunity_lines where opportunity_id = ${id} and org_id = ${gate.user.orgId}`)
    await tx.execute(sql`delete from crm_opportunity_stage_events where opportunity_id = ${id} and org_id = ${gate.user.orgId}`)
    return tx.execute(sql`delete from crm_opportunities where id = ${id} and org_id = ${gate.user.orgId} returning id`)
  }) as unknown as { rows: unknown[] }
  return deleted.rows[0] ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
