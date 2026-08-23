import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { provisionFeatureDefaults } from '@openbooks/engine/src/organization-provisioning.ts'
import { guardPermission } from '../../../../../lib/authz'
import {
  FEATURES,
  FEATURE_BY_KEY,
  featureDisableBlocked,
  featureEnabled,
  featureRequirements,
} from '../../../../../lib/features'

export const dynamic = 'force-dynamic'

/**
 * Toggle optional features on/off for the org. Only registry keys are
 * accepted. Enabling a feature installs its editable baseline configuration;
 * disabling it preserves all existing data and only hides its surfaces.
 */
export async function PUT(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
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
    const before = (await tx.execute<{ features: Record<string, boolean> }>(sql`
      select coalesce(settings->'features', '{}'::jsonb) as features
        from orgs where id = ${orgId} for update`))
    if (!before.rows[0]) return { error: 'not-found' }
    const currentState = before.rows[0].features ?? {}
    const after = { ...currentState, ...clean }
    for (const [key, value] of Object.entries(clean)) {
      if (!value) continue
      const missing = featureRequirements(FEATURE_BY_KEY.get(key)!)
        .filter((requiredKey) => !featureEnabled(after, requiredKey))
      if (missing.length > 0) return { error: 'feature-dependency', key, requiredKeys: missing }
    }
    // Do not leave a stored-on child silently suppressed by switching off one
    // of its requirements. Administrators must make that scope change explicit.
    for (const [key, value] of Object.entries(clean)) {
      if (value) continue
      const dependents = FEATURES.filter((candidate) =>
        featureRequirements(candidate).includes(key)
        && (typeof after[candidate.key] === 'boolean' ? after[candidate.key] : candidate.defaultEnabled),
      ).map((candidate) => candidate.key)
      if (dependents.length > 0) return { error: 'feature-dependents-enabled', key, dependentKeys: dependents }
    }
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
  if (clean.scripts !== undefined) {
    const { refreshScheduledNextRuns } = await import('@openbooks/engine/src/scripting.ts')
    await refreshScheduledNextRuns(orgId)
  }
  for (const [key, enabled] of Object.entries(clean)) {
    if (enabled) await provisionFeatureDefaults(orgId, gate.user.id, key)
  }
  return NextResponse.json({ ok: true })
}
