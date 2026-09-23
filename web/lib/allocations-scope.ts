import "server-only";
import { NextResponse } from "next/server";
import {
  RunQueryError,
  getRun,
  type RunDetail,
} from "../../engine/src/allocations/run-queries.ts";
import { allocationScopeVisible } from "../../engine/src/allocations/subsidiary-scope.ts";

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
