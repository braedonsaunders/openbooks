import "server-only";
import { NextResponse } from "next/server";
import {
  RunQueryError,
  getRun,
  type RunDetail,
} from "../../engine/src/allocations/run-queries.ts";
import {
  allocationRuleVisible,
  allocationScopeVisible,
} from "../../engine/src/allocations/subsidiary-scope.ts";
import type { RuleInEffect } from "../../engine/src/allocations/types.ts";

/**
 * Allocation run scope gate (m40_allocation_scope): the ONE shared helper
 * every mutating run route (post/reverse/rerun) uses before touching the
 * engine. `getRun` already scopes by org, so a foreign-org id lands here as
 * not_found; a run the caller cannot fully see — pin plus every subsidiary
 * the stored computation touches — is refused the same tenant-opaque 404
 * the GET detail route answers, never a lifecycle or permission shape that
 * would confirm the run exists.
 */
export async function requireVisibleAllocationRun(
  orgId: string,
  runId: string,
  allowed: ReadonlySet<string> | null,
): Promise<RunDetail | NextResponse> {
  let run: RunDetail;
  try {
    run = await getRun(orgId, runId);
  } catch (error) {
    if (error instanceof RunQueryError && error.code === "not_found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw error;
  }
  if (!allocationScopeVisible(allowed, run.subsidiaryId, run.computation)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return run;
}

/**
 * Rule-catalog visibility (m40_allocation_scope, configuration half): the
 * same rule-scope logic the configuration writes enforce — a restricted
 * caller sees a rule only when every subsidiary its sources and targets
 * touch is in their set; an org-wide rule needs the full unrestricted
 * scope. Used to filter enumeration surfaces like entry-candidates.
 */
export function allocationRuleScopeVisible(
  allowed: ReadonlySet<string> | null,
  rule: Pick<RuleInEffect, "version" | "targets">,
): boolean {
  return allocationRuleVisible(allowed, {
    sourceSubsidiaryIds: rule.version.dimensionFilters.subsidiaryIds,
    targetKind: rule.version.targetKind,
    dynamicDimension: rule.version.dynamicTarget.dimension,
    dynamicIncludes: rule.version.dynamicTarget.include,
    targetSubsidiaryIds: rule.targets.map((t) => t.subsidiaryId),
  });
}
