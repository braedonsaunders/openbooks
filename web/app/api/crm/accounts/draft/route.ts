import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { ensureCrmDefaults } from '@openbooks/engine/src/crm/crm.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

const DRAFT_STAGES = ['lead', 'prospect'] as const
type DraftStage = (typeof DRAFT_STAGES)[number]

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('crm.accounts.create', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  if (gate.allowedSubsidiaryIds?.size === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // The factory stays bodyless-tolerant ({} or no body means a lead) and reads
  // only an optional stage: the unified account list's New button passes the
  // lifecycle segment it is on, so prospects come through this same endpoint.
  // Anything else fails closed instead of silently minting a lead.
  const rawBody: unknown = await req.json().catch(() => ({}))
  const rawStage = typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody)
    ? (rawBody as Record<string, unknown>).lifecycleStage
    : undefined
  const stage: DraftStage = rawStage === undefined ? 'lead' : rawStage as DraftStage
  if (!DRAFT_STAGES.includes(stage)) return NextResponse.json({ error: 'invalid lifecycle stage' }, { status: 422 })
  // 'New lead' stays the shared inactive-placeholder sentinel for both stages:
  // the parties PATCH completes it reason-free and the drawer blanks it.
  const reason = stage === 'lead' ? 'Lead created' : 'Prospect created'
  await ensureCrmDefaults(user.orgId, user.id)
  const result = await db.transaction(async (tx) => {
    const party = (await tx.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name, is_active, created_by, updated_by)
      values (${user.orgId}, 'company', 'New lead', false, ${user.id}, ${user.id}) returning id
    `))
    const status = (await tx.execute<{ id: string }>(sql`
      select id from crm_account_statuses
       where org_id = ${user.orgId} and lifecycle_stage = ${stage} and is_default and is_active
       order by sequence limit 1`))
    const profile = (await tx.execute<{ id: string }>(sql`
      insert into crm_account_profiles
        (org_id, party_id, lifecycle_stage, status_id, owner_user_id, is_active, created_by, updated_by)
      values (${user.orgId}, ${party.rows[0]!.id}, ${stage}, ${status.rows[0]?.id ?? null}, ${user.id}, false, ${user.id}, ${user.id})
      returning id`))
    await tx.execute(sql`
      insert into crm_account_stage_events
        (org_id, account_profile_id, to_stage, source_kind, reason, created_by, updated_by)
      values (${user.orgId}, ${profile.rows[0]!.id}, ${stage}, 'manual', ${reason}, ${user.id}, ${user.id})`)
    return { id: party.rows[0]!.id }
  })
  return NextResponse.json(result)
}
