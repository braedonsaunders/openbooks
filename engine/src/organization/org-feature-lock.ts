import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
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
