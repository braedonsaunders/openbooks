import { crmSharedScope } from '../../../../../lib/crm-scope'
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { promoteCrmAccount, routeCrmAccount } from '@openbooks/engine/src/crm/crm.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { loadCrmAccount } from '../../../../../lib/crm'
import { isIsoTimestamp } from '../../../../../lib/crm-dates'
import { canonicalDecimal, compareDecimal } from '../../../../../lib/exact-decimal'

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

// Free-text columns clear on null/'' but must actually be text: a number or
// object would otherwise sail through textOrNull as a silent clear.
function textOrInvalid(value: unknown): string | null | 'invalid' {
  if (value === null) return null
  if (typeof value !== 'string') return 'invalid'
  return value.trim() ? value.trim() : null
}

/**
 * The relationship record for one party, plus the pickers its editor needs.
 *
 * `options` rides along because the editor is a TAB of the party flyout, not
 * a page with its own server loader: one round trip has to answer both "what
 * is this relationship" and "what may it become", or the tab renders selects
 * with no choices in them. `account: null` is a 200, not a 404 — a customer
 * created outside CRM simply has no profile yet, and the tab offers to start
 * one (see POST).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.accounts.read', 'crm')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const orgId = gate.user.orgId
  const visible = (await db.execute(sql`
    select 1 from parties where id = ${id} and org_id = ${orgId}${crmSharedScope(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}`))
  if (!visible.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const [account, statuses, owners, territories, sources] = await Promise.all([
    loadCrmAccount(id, orgId, gate.allowedSubsidiaryIds),
    db.execute<{ id: string; name: string; lifecycle_stage: string; is_default: boolean }>(sql`
      select id, name, lifecycle_stage, is_default from crm_account_statuses
       where org_id = ${orgId} and is_active order by lifecycle_stage, sequence, name`),
    db.execute<{ id: string; name: string }>(sql`select id, name from users where org_id = ${orgId} and is_active order by name`),
    db.execute<{ id: string; name: string }>(sql`select id, name from crm_sales_territories where org_id = ${orgId} and is_active order by priority, name`),
    db.execute<{ id: string; name: string }>(sql`select id, name from crm_lead_sources where org_id = ${orgId} and is_active order by name`),
  ])
  return NextResponse.json({
    account,
    options: {
      statuses: statuses.rows,
      owners: owners.rows,
      territories: territories.rows,
      sources: sources.rows,
    },
  })
}

/**
 * Start tracking an existing party as a relationship.
 *
 * Customers minted by the AR side (or by an import) carry a customer role and
 * no crm_account_profiles row, so PATCH has nothing to update. This opens the
 * profile at the stage the party already IS — `customer` when it holds an
 * active customer role, `lead` otherwise — and records the stage event, so
 * the lifecycle history starts honest instead of claiming a conversion that
 * never happened. It is deliberately idempotent-ish: an existing profile wins.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.accounts.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const created = await db.transaction(async (tx) => {
    const party = (await tx.execute<{ id: string }>(sql`
      select id from parties where id = ${id} and org_id = ${user.orgId}${crmSharedScope(sql`subsidiary_id`, gate.allowedSubsidiaryIds)} for update`))
    if (!party.rows.length) return 'missing' as const
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from crm_account_profiles where org_id = ${user.orgId} and party_id = ${id}`))
    if (existing.rows.length) return 'exists' as const
    const isCustomer = (await tx.execute(sql`
      select 1 from customer_roles where org_id = ${user.orgId} and party_id = ${id} and is_active`)).rows.length > 0
    const stage: Stage = isCustomer ? 'customer' : 'lead'
    const status = (await tx.execute<{ id: string }>(sql`
      select id from crm_account_statuses
       where org_id = ${user.orgId} and lifecycle_stage = ${stage} and is_default and is_active
       order by sequence limit 1`))
    const profile = (await tx.execute<{ id: string }>(sql`
      insert into crm_account_profiles
        (org_id, party_id, lifecycle_stage, status_id, owner_user_id, converted_at, is_active, created_by, updated_by)
      values (${user.orgId}, ${id}, ${stage}, ${status.rows[0]?.id ?? null}, ${user.id},
              ${stage === 'customer' ? sql`now()` : null}, true, ${user.id}, ${user.id})
      returning id`))
    await tx.execute(sql`
      insert into crm_account_stage_events
        (org_id, account_profile_id, to_stage, source_kind, reason, created_by, updated_by)
      values (${user.orgId}, ${profile.rows[0]!.id}, ${stage}, 'manual', 'Relationship tracking started', ${user.id}, ${user.id})`)
    return 'created' as const
  })
  if (created === 'missing') return NextResponse.json({ error: 'not found' }, { status: 404 })
  const account = await loadCrmAccount(id, user.orgId, gate.allowedSubsidiaryIds)
  return NextResponse.json({ account })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.accounts.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as Record<string, unknown>
  const current = (await db.execute<{ id: string; lifecycle_stage: string; owner_user_id: string | null; territory_id: string | null }>(sql`
    select cp.*, p.display_name, p.is_active as party_active
      from crm_account_profiles cp join parties p on p.id = cp.party_id and p.org_id = cp.org_id
     where cp.party_id = ${id} and cp.org_id = ${user.orgId}${crmSharedScope(sql`p.subsidiary_id`,gate.allowedSubsidiaryIds)}`))
  const row = current.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const stage = body.lifecycleStage === undefined ? undefined : String(body.lifecycleStage) as Stage
  if (stage !== undefined && !STAGES.includes(stage)) return NextResponse.json({ error: 'invalid lifecycle stage' }, { status: 422 })
  const statusId = body.statusId === undefined ? undefined : uuidOrNull(body.statusId)
  if (statusId === 'invalid') return NextResponse.json({ error: 'invalid statusId: expected a UUID' }, { status: 422 })
  const ownerUserId = body.ownerUserId === undefined ? undefined : uuidOrNull(body.ownerUserId)
  if (ownerUserId === 'invalid') return NextResponse.json({ error: 'invalid ownerUserId: expected a UUID' }, { status: 422 })
  const territoryId = body.territoryId === undefined ? undefined : uuidOrNull(body.territoryId)
  if (territoryId === 'invalid') return NextResponse.json({ error: 'invalid territoryId: expected a UUID' }, { status: 422 })
  const leadSourceId = body.leadSourceId === undefined ? undefined : uuidOrNull(body.leadSourceId)
  if (leadSourceId === 'invalid') return NextResponse.json({ error: 'invalid leadSourceId: expected a UUID' }, { status: 422 })
  // Number() coerces booleans and single-element arrays (true -> 1), so the
  // type gate comes first: only numbers and numeric strings reach it.
  if (body.qualificationScore !== undefined && body.qualificationScore !== null && body.qualificationScore !== ''
    && typeof body.qualificationScore !== 'number' && typeof body.qualificationScore !== 'string') {
    return NextResponse.json({ error: 'qualification score must be from 0 to 100' }, { status: 422 })
  }
  const score = body.qualificationScore === undefined || body.qualificationScore === null || body.qualificationScore === ''
    ? null : Number(body.qualificationScore)
  if (score !== null && (!Number.isInteger(score) || score < 0 || score > 100)) return NextResponse.json({ error: 'qualification score must be from 0 to 100' }, { status: 422 })
  if (body.employeeCount !== undefined && body.employeeCount !== null && body.employeeCount !== ''
    && typeof body.employeeCount !== 'number' && typeof body.employeeCount !== 'string') {
    return NextResponse.json({ error: 'employee count must be a whole number from 0 to 2147483647' }, { status: 422 })
  }
  const employeeCount = body.employeeCount === undefined || body.employeeCount === null || body.employeeCount === ''
    ? null : Number(body.employeeCount)
  if (employeeCount !== null && (!Number.isInteger(employeeCount) || employeeCount < 0 || employeeCount > 2147483647)) return NextResponse.json({ error: 'employee count must be a whole number from 0 to 2147483647' }, { status: 422 })
  // A present isActive that is not a boolean used to deactivate the account:
  // null, "true" and 1 all compared unequal to true and wrote false.
  const isActive = body.isActive === undefined ? undefined
    : typeof body.isActive === 'boolean' ? body.isActive : 'invalid' as const
  if (isActive === 'invalid') return NextResponse.json({ error: 'isActive must be a boolean' }, { status: 422 })
  const industry = body.industry === undefined ? undefined : textOrInvalid(body.industry)
  if (industry === 'invalid') return NextResponse.json({ error: 'industry must be a string' }, { status: 422 })
  const category = body.category === undefined ? undefined : textOrInvalid(body.category)
  if (category === 'invalid') return NextResponse.json({ error: 'category must be a string' }, { status: 422 })
  const stageReason = body.stageReason === undefined ? undefined : textOrInvalid(body.stageReason)
  if (stageReason === 'invalid') return NextResponse.json({ error: 'stage reason must be a string' }, { status: 422 })
  const assignmentReason = body.assignmentReason === undefined ? undefined : textOrInvalid(body.assignmentReason)
  if (assignmentReason === 'invalid') return NextResponse.json({ error: 'assignment reason must be a string' }, { status: 422 })
  const annualRevenueRaw = body.annualRevenue === undefined || body.annualRevenue === null || body.annualRevenue === ''
    ? null
    : canonicalDecimal(body.annualRevenue, 4)
  if (body.annualRevenue !== undefined && body.annualRevenue !== null && body.annualRevenue !== ''
    && (annualRevenueRaw === null || compareDecimal(annualRevenueRaw, '0') < 0)) {
    return NextResponse.json({ error: 'annual revenue must be a non-negative amount' }, { status: 422 })
  }
  // annual_revenue is numeric(19,4): refuse wider figures here instead of
  // dying in Postgres as a raw overflow (HTTP 500 — this verb has no catch).
  if (annualRevenueRaw !== null && annualRevenueRaw.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length > 15) {
    return NextResponse.json({ error: 'annual revenue must fit the ledger (at most 15 whole digits)' }, { status: 422 })
  }
  const annualRevenue = annualRevenueRaw === null ? null : normalizeMoney(annualRevenueRaw)
  if (body.nextActionAt != null && body.nextActionAt !== '' && !isIsoTimestamp(body.nextActionAt)) {
    return NextResponse.json({ error: 'invalid nextActionAt: expected an ISO date or date-time' }, { status: 422 })
  }
  const qualification = body.qualification === undefined ? undefined : body.qualification
  if (qualification !== undefined && (qualification === null || typeof qualification !== 'object' || Array.isArray(qualification))) {
    return NextResponse.json({ error: 'qualification must be an object' }, { status: 422 })
  }

  const rank = { lead: 0, prospect: 1, customer: 2 }
  const promoting = !!stage && rank[stage] > rank[row.lifecycle_stage as Stage]
  let statusStage: string | null = null
  if (statusId && typeof statusId === 'string') {
    const owner = (await db.execute<{ lifecycle_stage: string }>(sql`
      select lifecycle_stage from crm_account_statuses where id = ${statusId} and org_id = ${user.orgId} and is_active`))
    statusStage = owner.rows[0]?.lifecycle_stage ?? null
    // Unknown or inactive statuses always fail closed. A known status from
    // another stage is only a conflict when nothing explains it: a forward
    // stage change re-defaults the status (the drawer sends the whole form,
    // stale status included), so the stage write must not die with it.
    if (statusStage === null) return NextResponse.json({ error: 'status does not belong to this stage' }, { status: 422 })
    if (statusStage !== (stage ?? row.lifecycle_stage) && !promoting) {
      return NextResponse.json({ error: 'status does not belong to this stage' }, { status: 422 })
    }
  }
  // On promotion an explicit status only wins when it names the target stage;
  // a stale (or cleared) status leaves the default promoteCrmAccount assigned
  // in place instead of rejecting the save or nulling the fresh default.
  const statusWrite = promoting && statusStage !== stage ? undefined : statusId
  const referenceChecks = await Promise.all([
    ownerUserId && ownerUserId !== 'invalid' ? db.execute(sql`select 1 from users where id = ${ownerUserId} and org_id = ${user.orgId}`) : null,
    territoryId && territoryId !== 'invalid' ? db.execute(sql`select 1 from crm_sales_territories where id = ${territoryId} and org_id = ${user.orgId}`) : null,
    leadSourceId && leadSourceId !== 'invalid' ? db.execute(sql`select 1 from crm_lead_sources where id = ${leadSourceId} and org_id = ${user.orgId}`) : null,
  ])
  if (referenceChecks.some((result) => result && !(result as unknown as { rows: unknown[] }).rows[0])) {
    return NextResponse.json({ error: 'reference belongs to another organization' }, { status: 422 })
  }
  if (stage && ({ lead: 0, prospect: 1, customer: 2 })[stage] < ({ lead: 0, prospect: 1, customer: 2 })[row.lifecycle_stage as Stage] && !stageReason) {
    return NextResponse.json({ error: 'a reason is required to move an account backward' }, { status: 422 })
  }

  const denied = await db.transaction(async (tx) => {
    const visible = await tx.execute(sql`select id from parties where id=${id} and org_id=${user.orgId}${crmSharedScope(sql`subsidiary_id`,gate.allowedSubsidiaryIds)} for update`)
    if (!visible.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (stage && stage !== row.lifecycle_stage) {
      const rank = { lead: 0, prospect: 1, customer: 2 }
      if (rank[stage] > rank[row.lifecycle_stage as Stage]) {
        const promotion = await promoteCrmAccount(tx, { orgId: user.orgId, partyId: id, actorId: user.id, toStage: stage, sourceKind: 'manual', reason: stageReason ?? null })
        // This route is CRM-gated, so lifecycle bookkeeping must land; a
        // customer promotion additionally requires the AR role.
        if (!promotion.lifecycleApplied) {
          throw new Error('CRM lifecycle transition was not applied')
        }
        if (stage === 'customer' && !promotion.customerRoleActive) {
          throw new Error('customer role was not established while promoting the account')
        }
      } else {
        const reason = stageReason ?? null
        await tx.execute(sql`
          update crm_account_profiles set lifecycle_stage = ${stage},
                 status_id = ${statusId !== undefined ? statusId : sql`status_id`},
                 updated_at = now(), updated_by = ${user.id} where id = ${row.id} and org_id = ${user.orgId}`)
        await tx.execute(sql`
          insert into crm_account_stage_events
            (org_id, account_profile_id, from_stage, to_stage, source_kind, reason, created_by, updated_by)
          values (${user.orgId}, ${row.id}, ${row.lifecycle_stage}, ${stage}, 'manual', ${reason}, ${user.id}, ${user.id})`)
      }
    }
    await tx.execute(sql`
      update crm_account_profiles set
        status_id = ${statusWrite !== undefined ? statusWrite : sql`status_id`},
        owner_user_id = ${ownerUserId !== undefined ? ownerUserId : sql`owner_user_id`},
        territory_id = ${territoryId !== undefined ? territoryId : sql`territory_id`},
        lead_source_id = ${leadSourceId !== undefined ? leadSourceId : sql`lead_source_id`},
        industry = ${industry !== undefined ? industry : sql`industry`},
        category = ${category !== undefined ? category : sql`category`},
        annual_revenue = ${body.annualRevenue !== undefined ? annualRevenue : sql`annual_revenue`},
        employee_count = ${body.employeeCount !== undefined ? employeeCount : sql`employee_count`},
        qualification_score = ${body.qualificationScore !== undefined ? score : sql`qualification_score`},
        qualification = ${qualification !== undefined ? JSON.stringify(qualification) : sql`qualification`}::jsonb,
        next_action_at = ${body.nextActionAt !== undefined ? textOrNull(body.nextActionAt) : sql`next_action_at`},
        is_active = ${isActive !== undefined ? isActive : sql`is_active`},
        updated_at = now(), updated_by = ${user.id}
      where id = ${row.id} and org_id = ${user.orgId}`)
    if ((ownerUserId !== undefined && ownerUserId !== row.owner_user_id) || (territoryId !== undefined && territoryId !== row.territory_id)) {
      await tx.execute(sql`
        insert into crm_account_assignment_events
          (org_id, account_profile_id, from_owner_user_id, to_owner_user_id, from_territory_id, to_territory_id,
           source, reason, created_by, updated_by)
        values (${user.orgId}, ${row.id}, ${row.owner_user_id}, ${ownerUserId === undefined ? row.owner_user_id : ownerUserId},
                ${row.territory_id}, ${territoryId === undefined ? row.territory_id : territoryId},
                'manual', ${assignmentReason ?? null}, ${user.id}, ${user.id})`)
    }
    // The audit records the profile row actually written, re-read in this
    // transaction — not the request body, which may name fields the write
    // ignored and values the validators normalized.
    const after = (await tx.execute(sql`
      select cp.*, p.display_name, p.is_active as party_active
        from crm_account_profiles cp join parties p on p.id = cp.party_id and p.org_id = cp.org_id
       where cp.id = ${row.id} and cp.org_id = ${user.orgId}`)).rows[0]
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'crm_account_profiles', ${row.id}, 'update',
              ${JSON.stringify({ before: row, after })}::jsonb, ${user.id})`)
  })
  if (denied) return denied
  if (body.route === true) await routeCrmAccount(user.orgId, row.id, user.id)
  const result = await loadCrmAccount(id, user.orgId, gate.allowedSubsidiaryIds)
  return NextResponse.json(result)
}
