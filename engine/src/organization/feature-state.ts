import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '../platform/db.ts'
import { featureEnabled, type FeatureState } from './feature-registry.ts'
import { dataDependentFeatureDefault } from './feature-defaults.ts'
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from './org-feature-lock.ts'

/** Load the org's feature state (raw overrides; combine with featureEnabled). */
export async function orgFeatureState(orgId: string, executor: SqlExecutor = db): Promise<FeatureState> {
  const r = (await executor.execute<{ f: FeatureState | null }>(sql`select settings->'features' as f from orgs where id = ${orgId}`))
  return r.rows[0]?.f ?? {}
}

/** Server helper for route guards: is this feature on for the org? Resolves
 * the data-dependent defaults exactly like resolvedFeatureState, so guards
 * agree with the Features page and the setup-entity gate. */
export async function isFeatureEnabled(orgId: string, key: string, executor: SqlExecutor = db): Promise<boolean> {
  const state = await orgFeatureState(orgId, executor)
  if (key === 'multiSubsidiary') return resolveMultiSubsidiary(orgId, state, executor)
  if (key === 'multiCurrency') return resolveMultiCurrency(orgId, state, executor)
  return featureEnabled(state, key)
}

/**
 * `multiSubsidiary` has a DATA-DEPENDENT default resolved by the single
 * engine helper: on iff the org already runs more than one subsidiary. This
 * keeps existing multi-entity orgs working when the flag was never
 * explicitly set, and lets a single-entity org opt in to add its first extra
 * subsidiary. An explicit stored boolean always wins.
 */
async function resolveMultiSubsidiary(orgId: string, state: FeatureState, executor: SqlExecutor = db): Promise<boolean> {
  return dataDependentFeatureDefault(executor, orgId, 'multiSubsidiary', state)
}

/** Is multi-subsidiary on for this org (with the data-dependent default)? */
export async function subsidiaryFeatureEnabled(orgId: string, executor: SqlExecutor = db): Promise<boolean> {
  return resolveMultiSubsidiary(orgId, await orgFeatureState(orgId, executor), executor)
}

/**
 * `multiCurrency` default resolved by the single engine helper: on iff the
 * org has already touched foreign currency. Keeps existing multi-currency
 * orgs working when the flag was never set; an explicit stored boolean
 * always wins.
 */
async function resolveMultiCurrency(orgId: string, state: FeatureState, executor: SqlExecutor = db): Promise<boolean> {
  return dataDependentFeatureDefault(executor, orgId, 'multiCurrency', state)
}

/**
 * Feature state with data-dependent defaults resolved to explicit booleans
 * (`multiSubsidiary`, `multiCurrency`). Use this for the Features page and
 * the setup-rail gating so `featureEnabled` returns the correct value.
 */
export async function resolvedFeatureState(orgId: string, executor: SqlExecutor = db): Promise<FeatureState> {
  const state = await orgFeatureState(orgId, executor)
  const [multiSubsidiary, multiCurrency] = [await resolveMultiSubsidiary(orgId, state, executor), await resolveMultiCurrency(orgId, state, executor)]
  return { ...state, multiSubsidiary, multiCurrency }
}

/** Fence project-linked writes against disabling Projects; use the writer's transaction. */
export async function checkProjectsWriteEnabled(orgId: string, executor: SqlExecutor = db): Promise<boolean> {
  await acquireOrgFeatureGateLock(executor, orgId)
  return lockAndCheckOrgFeature(executor, orgId, 'projects')
}
