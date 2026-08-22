import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { promoteCrmAccount, routeCrmAccount } from '@openbooks/engine/src/crm.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { loadCrmAccount } from '../../../../../lib/crm'

export const runtime = 'nodejs'

const STAGES = ['lead', 'prospect', 'customer'] as const
type Stage = (typeof STAGES)[number]

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function uuidOrNull(value: unknown): string | null | 'invalid' {
  const valueText = textOrNull(value)
  return valueText === null ? null : isUuid(valueText) ? valueText : 'invalid'
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.accounts.read', 'crm')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const account = await loadCrmAccount(id, gate.user.orgId)
  return account ? NextResponse.json(account) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.accounts.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json() as Record<string, unknown>
  const current = (await db.execute<any>(sql`
    select cp.*, p.display_name, p.is_active as party_active
      from crm_account_profiles cp join parties p on p.id = cp.party_id and p.org_id = cp.org_id
     where cp.party_id = ${id} and cp.org_id = ${user.orgId}`))
  const row = current.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const stage = body.lifecycleStage === undefined ? undefined : String(body.lifecycleStage) as Stage
  if (stage !== undefined && !STAGES.includes(stage)) return NextResponse.json({ error: 'invalid lifecycle stage' }, { status: 422 })
  const statusId = body.statusId === undefined ? undefined : uuidOrNull(body.statusId)
  const ownerUserId = body.ownerUserId === undefined ? undefined : uuidOrNull(body.ownerUserId)
  const territoryId = body.territoryId === undefined ? undefined : uuidOrNull(body.territoryId)
  const leadSourceId = body.leadSourceId === undefined ? undefined : uuidOrNull(body.leadSourceId)
  if ([statusId, ownerUserId, territoryId, leadSourceId].includes('invalid')) return NextResponse.json({ error: 'invalid reference' }, { status: 422 })
  const score = body.qualificationScore === undefined || body.qualificationScore === null || body.qualificationScore === ''
    ? null : Number(body.qualificationScore)
  if (score !== null && (!Number.isInteger(score) || score < 0 || score > 100)) return NextResponse.json({ error: 'qualification score must be from 0 to 100' }, { status: 422 })
  const employeeCount = body.employeeCount === undefined || body.employeeCount === null || body.employeeCount === ''
    ? null : Number(body.employeeCount)
  if (employeeCount !== null && (!Number.isInteger(employeeCount) || employeeCount < 0)) return NextResponse.json({ error: 'employee count must be non-negative' }, { status: 422 })
  const annualRevenue = textOrNull(body.annualRevenue)
  if (annualRevenue !== null && (!/^\d+(\.\d{0,4})?$/.test(annualRevenue))) return NextResponse.json({ error: 'annual revenue must be a non-negative amount' }, { status: 422 })
  const qualification = body.qualification === undefined ? undefined : body.qualification
  if (qualification !== undefined && (qualification === null || typeof qualification !== 'object' || Array.isArray(qualification))) {
    return NextResponse.json({ error: 'qualification must be an object' }, { status: 422 })
  }

  if (statusId && typeof statusId === 'string') {
    const valid = (await db.execute(sql`
      select 1 from crm_account_statuses where id = ${statusId} and org_id = ${user.orgId}
        and lifecycle_stage = ${stage ?? row.lifecycle_stage} and is_active`))
    if (!valid.rows[0]) return NextResponse.json({ error: 'status does not belong to this stage' }, { status: 422 })
  }
  const referenceChecks = await Promise.all([
    ownerUserId && ownerUserId !== 'invalid' ? db.execute(sql`select 1 from users where id = ${ownerUserId} and org_id = ${user.orgId}`) : null,
    territoryId && territoryId !== 'invalid' ? db.execute(sql`select 1 from crm_sales_territories where id = ${territoryId} and org_id = ${user.orgId}`) : null,
    leadSourceId && leadSourceId !== 'invalid' ? db.execute(sql`select 1 from crm_lead_sources where id = ${leadSourceId} and org_id = ${user.orgId}`) : null,
  ])
  if (referenceChecks.some((result) => result && !(result as unknown as { rows: unknown[] }).rows[0])) {
    return NextResponse.json({ error: 'reference belongs to another organization' }, { status: 422 })
  }
  if (stage && ({ lead: 0, prospect: 1, customer: 2 })[stage] < ({ lead: 0, prospect: 1, customer: 2 })[row.lifecycle_stage as Stage] && !textOrNull(body.stageReason)) {
    return NextResponse.json({ error: 'a reason is required to move an account backward' }, { status: 422 })
  }

  await db.transaction(async (tx) => {
    if (stage && stage !== row.lifecycle_stage) {
      const rank = { lead: 0, prospect: 1, customer: 2 }
      if (rank[stage] > rank[row.lifecycle_stage as Stage]) {
        await promoteCrmAccount(tx, { orgId: user.orgId, partyId: id, actorId: user.id, toStage: stage, sourceKind: 'manual', reason: textOrNull(body.stageReason) })
      } else {
        const reason = textOrNull(body.stageReason)
        await tx.execute(sql`
          update crm_account_profiles set lifecycle_stage = ${stage}, status_id = ${statusId ?? null},
                 updated_at = now(), updated_by = ${user.id} where id = ${row.id}`)
        await tx.execute(sql`
          insert into crm_account_stage_events
            (org_id, account_profile_id, from_stage, to_stage, source_kind, reason, created_by, updated_by)
          values (${user.orgId}, ${row.id}, ${row.lifecycle_stage}, ${stage}, 'manual', ${reason}, ${user.id}, ${user.id})`)
      }
    }
    await tx.execute(sql`
      update crm_account_profiles set
        status_id = ${statusId !== undefined ? statusId : sql`status_id`},
        owner_user_id = ${ownerUserId !== undefined ? ownerUserId : sql`owner_user_id`},
        territory_id = ${territoryId !== undefined ? territoryId : sql`territory_id`},
        lead_source_id = ${leadSourceId !== undefined ? leadSourceId : sql`lead_source_id`},
        industry = ${body.industry !== undefined ? textOrNull(body.industry) : sql`industry`},
        category = ${body.category !== undefined ? textOrNull(body.category) : sql`category`},
        annual_revenue = ${body.annualRevenue !== undefined ? annualRevenue : sql`annual_revenue`},
        employee_count = ${body.employeeCount !== undefined ? employeeCount : sql`employee_count`},
        qualification_score = ${body.qualificationScore !== undefined ? score : sql`qualification_score`},
        qualification = ${qualification !== undefined ? JSON.stringify(qualification) : sql`qualification`}::jsonb,
        next_action_at = ${body.nextActionAt !== undefined ? textOrNull(body.nextActionAt) : sql`next_action_at`},
        is_active = ${body.isActive !== undefined ? body.isActive === true : sql`is_active`},
        updated_at = now(), updated_by = ${user.id}
      where id = ${row.id}`)
    if ((ownerUserId !== undefined && ownerUserId !== row.owner_user_id) || (territoryId !== undefined && territoryId !== row.territory_id)) {
      await tx.execute(sql`
        insert into crm_account_assignment_events
          (org_id, account_profile_id, from_owner_user_id, to_owner_user_id, from_territory_id, to_territory_id,
           source, reason, created_by, updated_by)
        values (${user.orgId}, ${row.id}, ${row.owner_user_id}, ${ownerUserId === undefined ? row.owner_user_id : ownerUserId},
                ${row.territory_id}, ${territoryId === undefined ? row.territory_id : territoryId},
                'manual', ${textOrNull(body.assignmentReason)}, ${user.id}, ${user.id})`)
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'crm_account_profiles', ${row.id}, 'update',
              ${JSON.stringify({ before: row, requested: body })}::jsonb, ${user.id})`)
  })
  if (body.route === true) await routeCrmAccount(user.orgId, row.id, user.id)
  const result = await loadCrmAccount(id, user.orgId)
  return NextResponse.json(result)
}
