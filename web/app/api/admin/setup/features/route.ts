import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { provisionFeatureDefaults } from '@openbooks/engine/src/organization-provisioning.ts'
import { guardPermission } from '../../../../../lib/authz'
import {
  FEATURES,
  FEATURE_BY_KEY,
  acquireFeatureGateLock,
  featureDisableBlocked,
  featureEnabled,
  featureRequirements,
} from '../../../../../lib/features'

export const dynamic = 'force-dynamic'

/**
 * Toggle optional features on/off for the org. Only registry keys are
 * accepted. Enabling a feature installs its editable baseline configuration;
 * disabling it preserves all existing data and only hides its surfaces.
 *
 * The stored flags, scheduler reconciliation, and baseline provisioning commit
 * as ONE atomic unit: a provisioning or schedule-refresh failure rolls the
 * whole toggle back, so the org can never hold an enabled-but-unprovisioned
 * feature (its surfaces would render against missing defaults) or a stale
 * executable schedule for a disabled scripts feature. Provisioning is
 * idempotent, so retrying a failed toggle converges exactly once.
 *
 * The turn-off blockers are evaluated INSIDE this transaction, under the org's
 * feature-gate fence (`acquireFeatureGateLock`): an operation that could create
 * a blocker — a project activating under the `projects` gate — takes the same
 * fence before changing active state, so the two operations serialize and the
 * outcome is always a refused disable or a refused activation. Evaluating the
 * blockers before the transaction would leave a window where both apply.
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

  const dependencyError = await withOrgTransaction(orgId, async () => {
    // Serialize against every operation that can establish a feature dependency
    // (project activation/creation). Held to commit, so no blocker can appear
    // between the checks below and the flag write.
    await acquireFeatureGateLock(orgId)
    // Inside this pinned tenant transaction every db call below (including the
    // ones inside the engine's provisioning and scripting helpers) routes to
    // the same connection, so a failure anywhere rolls back the flags, the
    // audit evidence, the schedule refresh, and the baseline defaults
    // together.
    const before = await db.execute<{ features: Record<string, boolean> }>(sql`
      select coalesce(settings->'features', '{}'::jsonb) as features
        from orgs where id = ${orgId} for update`)
    if (!before.rows[0]) return { error: 'not-found' }
    const currentState = before.rows[0].features ?? {}
    const after = { ...currentState, ...clean }
    // A feature whose disable-check is hard-blocked can't be turned off — its
    // data is structurally load-bearing (e.g. the ledger is partitioned per
    // subsidiary). Checked under the fence: a blocker that appears mid-flight
    // (an activation committing first) must refuse THIS disable.
    for (const [key, value] of Object.entries(clean)) {
      if (value === false && (await featureDisableBlocked(orgId, key))) {
        return { error: 'feature-blocked', key }
      }
    }
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
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', ${JSON.stringify(after)}::jsonb)
       where id = ${orgId}`)
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({
        before: { features: currentState },
        after: { features: after },
      })}, ${gate.user.id})`)
    // Reconcile schedules while the new flag state is visible to this
    // transaction: disabling scripts nulls next_run_at in the SAME commit that
    // stores the disable, so a scheduler pass can never execute a script for a
    // feature the org has already turned off.
    if (clean.scripts !== undefined) {
      const { refreshScheduledNextRuns } = await import('@openbooks/engine/src/scripting.ts')
      await refreshScheduledNextRuns(orgId)
    }
    // Install each enabled feature's editable baseline under the same
    // transaction. The helpers read the feature gate through the pinned
    // transaction (they see `after` above) and are all conflict-safe no-ops on
    // existing rows, so retries converge without duplicating defaults.
    for (const [key, enabled] of Object.entries(clean)) {
      if (enabled) await provisionFeatureDefaults(orgId, gate.user.id, key)
    }
    return null
  })
  if (dependencyError) return NextResponse.json(dependencyError, { status: dependencyError.error === 'not-found' ? 404 : 409 })
  return NextResponse.json({ ok: true })
}
