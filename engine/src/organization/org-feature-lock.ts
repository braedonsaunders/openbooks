import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { dataDependentFeatureDefault, type DataDependentFeatureKey } from "./feature-defaults.ts";
import { featureEnabled, type FeatureState } from "./feature-registry.ts";

/**
 * Stable fence identity for one org's feature switchboard. The web
 * switchboard (`web/lib/features.ts`) uses this same key: both sides of the
 * fence must hash the identical string or a disable and a creator will not
 * serialize against each other. Keep the literal in sync; the web fence
 * contract pins its own copy.
 */
export function featureGateLockKey(orgId: string): string {
  return `openbooks:feature-gate:${orgId}`;
}

/**
 * Acquire the org's feature-gate fence inside an open write transaction. The
 * lock is transaction-scoped, so it MUST run on the writer's transaction
 * runner: on a pooled autocommit connection it would release instantly and
 * fence nothing. Take it BEFORE `lockAndCheckOrgFeature` and hold it to
 * commit. The disable path (`applyFeatureChanges`) holds this same lock from
 * its blocker checks to its flag write, so a creator that establishes a
 * disable blocker (an active project, an open billing request or pay
 * application, a draft ticket or change order, an active subcontract) either
 * waits for the disable and then refuses on the recheck, or commits first
 * and makes the disable refuse — never both applied.
 */
export async function acquireOrgFeatureGateLock(
  runner: SqlExecutor,
  orgId: string,
): Promise<void> {
  await runner.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${featureGateLockKey(orgId)}, 0))`,
  );
}

/**
 * Recheck an authoritative feature inside an open write transaction. The row
 * lock keeps a concurrent settings change ordered with the caller's effects.
 * Missing organizations and unknown features fail closed.
 *
 * `multiSubsidiary` and `multiCurrency` resolve through the single
 * data-dependent-default helper (probed on the caller's runner, inside the
 * same transaction), so the engine gate agrees with the Features page and
 * the setup-entity gate.
 */
export async function lockAndCheckOrgFeature(
  runner: SqlExecutor,
  orgId: string,
  key: string,
): Promise<boolean> {
  const row = (await runner.execute<{ features: FeatureState | null }>(sql`
    select settings->'features' as features from orgs where id=${orgId} for share`)).rows[0];
  if (!row) return false;
  const stored = row.features ?? {};
  if (
    (key === "multiSubsidiary" || key === "multiCurrency") &&
    typeof stored[key] !== "boolean"
  ) {
    if (!(await dataDependentFeatureDefault(runner, orgId, key as DataDependentFeatureKey, stored))) {
      return false;
    }
    return featureEnabled({ ...stored, [key]: true }, key);
  }
  return featureEnabled(row.features, key);
}

/**
 * Read-gate resolution for one org's feature switchboard — the engine
 * counterpart to web/lib/features.ts `isFeatureEnabled`. Single-org gate
 * checks that used to read
 * `coalesce((settings->'features'->>'key')::boolean, <default>)` inline are
 * routed here instead: the inline cast throws 22P02 on a non-boolean stored
 * value (an import artifact like 'yes') so the guarded surface 500'd, and it
 * bypassed the registry's parent/requiresAll chains and data-dependent
 * defaults. This resolves through the same machinery the Features page uses —
 * the registry's `featureEnabled` (non-boolean falls back to default, parent
 * and requiresAll chains enforced) with the data-dependent defaults for
 * `multiSubsidiary`/`multiCurrency` — so a gate can never disagree with the
 * switchboard.
 *
 * Unlike `lockAndCheckOrgFeature` (the recheck inside an open write
 * transaction, fail-closed on a missing org), this is a pure read: an
 * unknown org resolves like the Features page does, from registry defaults.
 */
export async function orgFeatureEnabled(
  orgId: string,
  key: string,
  executor: SqlExecutor = db,
): Promise<boolean> {
  const row = (await executor.execute<{ features: FeatureState | null }>(sql`
    select settings->'features' as features from orgs where id = ${orgId}`)).rows[0];
  const stored = row?.features ?? {};
  if (
    (key === "multiSubsidiary" || key === "multiCurrency") &&
    typeof stored[key] !== "boolean"
  ) {
    return dataDependentFeatureDefault(executor, orgId, key as DataDependentFeatureKey, stored);
  }
  return featureEnabled(stored, key);
}
