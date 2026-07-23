import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { FEATURE_BY_KEY, featureDisableBlocked, featureEnabled } from '../../../../../lib/features'

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
    if (!FEATURE_BY_KEY.has(key) || typeof value !== 'boolean') {
      return NextResponse.json({ error: 'invalid-feature', key }, { status: 422 })
    }
    clean[key] = value
  }
  if (Object.keys(clean).length === 0) return NextResponse.json({ error: 'at least one feature is required' }, { status: 422 })

  // A feature whose disable-check is hard-blocked can't be turned off — its data
  // is structurally load-bearing (e.g. the ledger is partitioned per subsidiary).
  for (const [key, value] of Object.entries(clean)) {
    if (value === false && (await featureDisableBlocked(orgId, key))) {
      return NextResponse.json({ error: 'feature-blocked', key }, { status: 409 })
    }
  }

  const dependencyError = await db.transaction(async (tx) => {
    const before = (await tx.execute(sql`
      select coalesce(settings->'features', '{}'::jsonb) as features
        from orgs where id = ${orgId} for update`)) as unknown as { rows: { features: Record<string, boolean> }[] }
    if (!before.rows[0]) return { error: 'not-found' }
    const currentState = before.rows[0].features ?? {}
    for (const [key, value] of Object.entries(clean)) {
      const parentKey = FEATURE_BY_KEY.get(key)?.parentKey
      const parentWillBeEnabled = parentKey
        ? (clean[parentKey] ?? featureEnabled(currentState, parentKey))
        : true
      if (value && parentKey && !parentWillBeEnabled) return { error: 'feature-dependency', key, parentKey }
    }
    const after = { ...currentState, ...clean }
    await tx.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', ${JSON.stringify(after)}::jsonb)
       where id = ${orgId}`)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({
        before: { features: currentState },
        after: { features: after },
      })}, ${gate.user.id})`)
    return null
  })
  if (dependencyError) return NextResponse.json(dependencyError, { status: dependencyError.error === 'not-found' ? 404 : 409 })
  return NextResponse.json({ ok: true })
}
