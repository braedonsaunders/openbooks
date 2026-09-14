import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./db.ts";
import { dataDependentFeatureDefault, type DataDependentFeatureKey } from "./feature-defaults.ts";
import { featureEnabled, type FeatureState } from "./feature-registry.ts";

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
