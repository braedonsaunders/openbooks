import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { FEATURE_BY_KEY } from '../../../../../lib/features'

export const dynamic = 'force-dynamic'

/**
 * Toggle optional features on/off for the org. Only registry keys are
 * accepted; toggling never touches feature data — off just hides surfaces.
 */
export async function PUT(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const body = await req.json().catch(() => ({}))
  const input = body.features
  if (!input || typeof input !== 'object') return NextResponse.json({ error: 'features object required' }, { status: 422 })

  const clean: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (FEATURE_BY_KEY.has(key) && typeof value === 'boolean') clean[key] = value
  }
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb)
     where id = ${orgId}`)
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({ features: clean })}, ${gate.user.id})`)
  return NextResponse.json({ ok: true })
}
