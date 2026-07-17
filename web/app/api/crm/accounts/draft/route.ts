import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { ensureCrmDefaults } from '@openbooks/engine/src/crm.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

export async function POST() {
  const gate = await guardPermission('crm.accounts.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  await ensureCrmDefaults(user.orgId, user.id)
  const result = await db.transaction(async (tx) => {
    const party = (await tx.execute(sql`
      insert into parties (org_id, kind, display_name, is_active, created_by, updated_by)
      values (${user.orgId}, 'company', 'New lead', false, ${user.id}, ${user.id}) returning id
    `)) as unknown as { rows: { id: string }[] }
    const status = (await tx.execute(sql`
      select id from crm_account_statuses
       where org_id = ${user.orgId} and lifecycle_stage = 'lead' and is_default and is_active
       order by sequence limit 1`)) as unknown as { rows: { id: string }[] }
    const profile = (await tx.execute(sql`
      insert into crm_account_profiles
        (org_id, party_id, lifecycle_stage, status_id, owner_user_id, is_active, created_by, updated_by)
      values (${user.orgId}, ${party.rows[0]!.id}, 'lead', ${status.rows[0]?.id ?? null}, ${user.id}, false, ${user.id}, ${user.id})
      returning id`)) as unknown as { rows: { id: string }[] }
    await tx.execute(sql`
      insert into crm_account_stage_events
        (org_id, account_profile_id, to_stage, source_kind, reason, created_by, updated_by)
      values (${user.orgId}, ${profile.rows[0]!.id}, 'lead', 'manual', 'Lead created', ${user.id}, ${user.id})`)
    return { id: party.rows[0]!.id }
  })
  return NextResponse.json(result)
}
