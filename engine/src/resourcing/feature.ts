import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { ResourcingRefusal } from "./errors.ts";

/** Lock the switchboard and refuse a write while resourcing is disabled. */
export async function lockAndRequireResourcing(
  tx: SqlExecutor,
  orgId: string,
): Promise<void> {
  await acquireOrgFeatureGateLock(tx, orgId);
  if (!(await lockAndCheckOrgFeature(tx, orgId, "resourcing"))) {
    throw new ResourcingRefusal(
      409,
      "resourcing_feature_disabled",
      "Resourcing is disabled for this organization",
      "turn on Resourcing in Company Settings → Features",
    );
  }
}
