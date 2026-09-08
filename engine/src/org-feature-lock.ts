import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./db.ts";
import { featureEnabled, type FeatureState } from "./feature-registry.ts";

/**
 * Recheck an authoritative feature inside an open write transaction. The row
 * lock keeps a concurrent settings change ordered with the caller's effects.
 * Missing organizations and unknown features fail closed.
 */
export async function lockAndCheckOrgFeature(
  runner: SqlExecutor,
  orgId: string,
  key: string,
): Promise<boolean> {
  const row = (await runner.execute<{ features: FeatureState | null }>(sql`
    select settings->'features' as features from orgs where id=${orgId} for share`)).rows[0];
  return !!row && featureEnabled(row.features, key);
}
