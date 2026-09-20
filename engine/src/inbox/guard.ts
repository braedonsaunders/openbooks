/**
 * HR-15 inbox feature probe.
 *
 * HRM adapters return an empty list while the hrm feature is off — probed
 * explicitly through the org feature lock, never by catching a refusal.
 * The inbox is core and must stay up for every org; hrm-gated work simply
 * has no rows while its switch is off, and reappears when it is on (rows
 * are never deleted by the switch).
 */
import { HRM_FEATURE_KEY } from "../hrm/employment-read.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { db, type SqlExecutor } from "../platform/db.ts";

export async function hrmOn(exec: SqlExecutor = db, orgId?: string): Promise<boolean> {
  if (!orgId) return false;
  return lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY);
}
