import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { provisionFeatureDefaults } from '@openbooks/engine/src/provisioning/organization-provisioning.ts'
import {
  FEATURES,
  FEATURE_BY_KEY,
  acquireFeatureGateLock,
  featureDisableBlocked,
  featureEnabled,
  featureRequirements,
} from './features'

/**
 * The one authoritative feature-toggle command. The /api/admin/setup/features
 * route and the `update_features` application tool (chat + MCP) both call
 * this, so every surface shares the fence, the dependency rules, the audit
 * evidence, the schedule refresh, and the baseline provisioning — exactly as
 * the Features page does.
 *
 * Serialization: `acquireFeatureGateLock` is taken INSIDE the tenant
 * transaction and held to commit, so no project activation can establish a
 * dependency between the blocker checks and the flag write.
 */

export type FeatureToggleError =
  | { error: 'not-found' }
  | { error: 'feature-blocked'; key: string }
  | { error: 'feature-dependency'; key: string; requiredKeys: string[] }
  | { error: 'feature-dependents-enabled'; key: string; dependentKeys: string[] }

export type FeatureToggleResult =
  | { ok: true; before: Record<string, boolean>; after: Record<string, boolean> }
  | ({ ok: false } & FeatureToggleError)

/** Validate a raw `{ key: boolean }` map against the registry. */
export function normalizeFeatureChanges(
  input: unknown,
): { ok: true; changes: Record<string, boolean> } | { ok: false; error: string; key?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'features object required' }
  const clean: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!FEATURE_BY_KEY.has(key) || typeof value !== 'boolean') return { ok: false, error: 'invalid-feature', key }
    clean[key] = value
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: 'at least one feature is required' }
  return { ok: true, changes: clean }
}

export async function applyFeatureChanges(
  orgId: string,
  actorId: string,
  clean: Record<string, boolean>,
): Promise<FeatureToggleResult> {
  return withOrgTransaction(orgId, async () => {
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
    if (!before.rows[0]) return { ok: false, error: 'not-found' }
    const currentState = before.rows[0].features ?? {}
    const after = { ...currentState, ...clean }
    // A feature whose disable-check is hard-blocked can't be turned off — its
    // data is structurally load-bearing (e.g. the ledger is partitioned per
    // subsidiary). Checked under the fence: a blocker that appears mid-flight
    // (an activation committing first) must refuse THIS disable.
    for (const [key, value] of Object.entries(clean)) {
      if (value === false && (await featureDisableBlocked(orgId, key))) {
        return { ok: false, error: 'feature-blocked', key }
      }
    }
    for (const [key, value] of Object.entries(clean)) {
      if (!value) continue
      const missing = featureRequirements(FEATURE_BY_KEY.get(key)!)
        .filter((requiredKey) => !featureEnabled(after, requiredKey))
      if (missing.length > 0) return { ok: false, error: 'feature-dependency', key, requiredKeys: missing }
    }
    // Do not leave a stored-on child silently suppressed by switching off one
    // of its requirements. Administrators must make that scope change explicit.
    for (const [key, value] of Object.entries(clean)) {
      if (value) continue
      const dependents = FEATURES.filter((candidate) =>
        featureRequirements(candidate).includes(key)
        && (typeof after[candidate.key] === 'boolean' ? after[candidate.key] : candidate.defaultEnabled),
      ).map((candidate) => candidate.key)
      if (dependents.length > 0) return { ok: false, error: 'feature-dependents-enabled', key, dependentKeys: dependents }
    }
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', ${JSON.stringify(after)}::jsonb)
       where id = ${orgId}`)
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${JSON.stringify({
        before: { features: currentState },
        after: { features: after },
      })}, ${actorId})`)
    // Reconcile schedules while the new flag state is visible to this
    // transaction: disabling scripts nulls next_run_at in the SAME commit that
    // stores the disable, so a scheduler pass can never execute a script for a
    // feature the org has already turned off.
    if (clean.scripts !== undefined) {
      const { refreshScheduledNextRuns } = await import('@openbooks/engine/src/scripting/scripting.ts')
      await refreshScheduledNextRuns(orgId)
    }
    // Install each enabled feature's editable baseline under the same
    // transaction. The helpers read the feature gate through the pinned
    // transaction (they see `after` above) and are all conflict-safe no-ops on
    // existing rows, so retries converge without duplicating defaults.
    for (const [key, enabled] of Object.entries(clean)) {
      if (enabled) await provisionFeatureDefaults(orgId, actorId, key)
    }
    return { ok: true, before: currentState, after }
  })
}
