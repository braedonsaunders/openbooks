import type { SqlExecutor } from "../platform/db.ts";
import {
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../organization/org-feature-lock.ts";
import { ManufacturingFeatureDisabledError } from "./errors.ts";

export type ManufacturingFeatureKey = "manufacturing" | "manufacturingMrp" | "manufacturingSubcontract";

export async function assertManufacturingFeature(
  tx: SqlExecutor,
  orgId: string,
  key: ManufacturingFeatureKey,
): Promise<void> {
  if (!(await lockAndCheckOrgFeature(tx, orgId, key))) {
    throw new ManufacturingFeatureDisabledError(key);
  }
}

export function manufacturingFeatureEnabled(
  orgId: string,
  key: ManufacturingFeatureKey,
  executor?: SqlExecutor,
): Promise<boolean> {
  return executor === undefined
    ? orgFeatureEnabled(orgId, key)
    : orgFeatureEnabled(orgId, key, executor);
}
