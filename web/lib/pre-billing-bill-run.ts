import "server-only";
import { PreBillingError, type SubsidiaryScope, requireDate } from "./pre-billing-core";
import { createPrebill } from "./pre-billing-create";
import { listUnbilledProjects } from "./pre-billing-read";

export interface BillRunInput {
  periodStart?: string | null;
  periodEnd: string;
  /** Limit the run to these projects; omitted means every project with unbilled work. */
  projectIds?: string[] | null;
  notes?: string | null;
}

export interface BillRunResult {
  created: Array<{
    projectId: string;
    projectName: string;
    id: string;
    worksheetNumber: string;
    sourceCount: number;
  }>;
  skipped: Array<{ projectId: string; projectName: string; reason: string }>;
}

/**
 * Prepare a worksheet for every project with unbilled work through a cutoff.
 * Each project is prepared in its own transaction with the same locking and
 * reservation rules as a single worksheet, so one project's refusal (no work
 * before the cutoff, an exhausted not-to-exceed cap, a missing policy) is
 * reported with its reason and never blocks the others.
 */
export async function runBillRun(
  orgId: string,
  actorId: string,
  input: BillRunInput,
  scope: SubsidiaryScope = null,
): Promise<BillRunResult> {
  const periodEnd = requireDate(input.periodEnd, "Cutoff date");
  const periodStart = input.periodStart ? requireDate(input.periodStart, "Period start") : null;
  if (periodStart && periodStart > periodEnd)
    throw new PreBillingError("Period start must be on or before the cutoff date");
  const candidates = await listUnbilledProjects(orgId, scope);
  const wanted = input.projectIds?.length ? new Set(input.projectIds) : null;
  const targets = wanted ? candidates.filter((row) => wanted.has(row.projectId)) : candidates;
  if (wanted) {
    const unknown = [...wanted].filter(
      (projectId) => !candidates.some((row) => row.projectId === projectId),
    );
    if (unknown.length > 0) {
      throw new PreBillingError(
        "A selected project has no unbilled work available to prebill — refresh and try again",
        409,
      );
    }
  }
  if (targets.length === 0)
    throw new PreBillingError("No project has unbilled work available to prebill");
  const result: BillRunResult = { created: [], skipped: [] };
  for (const target of targets) {
    try {
      const created = await createPrebill(
        orgId,
        actorId,
        {
          projectId: target.projectId,
          periodStart,
          periodEnd,
          notes: input.notes ?? null,
        },
        scope,
      );
      result.created.push({
        projectId: target.projectId,
        projectName: target.projectName,
        ...created,
      });
    } catch (error) {
      if (!(error instanceof PreBillingError)) throw error;
      result.skipped.push({
        projectId: target.projectId,
        projectName: target.projectName,
        reason: error.message,
      });
    }
  }
  return result;
}
