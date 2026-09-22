import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { RecordFlowsResult, RecordFlowRun } from "./run.ts";

/**
 * Shared dispatch-result verdicts for every consumer of runRecordFlows.
 *
 * Three submission paths got the same shape wrong independently (documents
 * submit.ts, allocation period-run.ts, bank-account submit route): a dispatch
 * where one flow gates and another fails (or where zero gates result) was
 * treated as successful routing. Every consumer must refuse through these
 * helpers: fail closed on ANY failure, cancel whatever the dispatch opened,
 * and name the flow and the cause so the operator knows what to fix.
 */

/** A computed refusal: the dispatch cannot honestly route. Callers map this
 * to their own typed error (SubmitError, AllocationRunError, HTTP 422) — the
 * message already names the flow and the remedy. */
export class FlowDispatchError extends Error {
  readonly name = "FlowDispatchError";
}

/** The first gating run in a dispatch result, optionally for one flow. */
export function findGatingRun(
  result: RecordFlowsResult,
  flowId?: string,
): RecordFlowRun | undefined {
  return result.runs.find((r) => r.gatesCreated > 0 && (!flowId || r.flowId === flowId));
}

/**
 * The operator-readable reason a dispatch failed: the failed flow BY NAME
 * plus its cause. Null when the dispatch did not fail. Every refusal message
 * in every consumer is built from this one function so the remedy reads the
 * same everywhere.
 */
export function dispatchFailureReason(result: RecordFlowsResult): string | null {
  if (!result.failed) return null;
  const failed = result.runs.find((r) => r.status === "failed");
  if (failed) {
    const what = `approval flow "${failed.flowName}" failed`;
    return failed.error ? `${what}: ${failed.error}` : what;
  }
  return result.error ?? "flow dispatch failed before any flow ran";
}

/** Anything with a drizzle `execute` (the ambient `db` or a caller-owned `tx`). */
type SqlRunner = Pick<typeof db, "execute">;

/**
 * Cancel everything one dispatch opened: pending/escalated gates first, then
 * their still-open runs. Terminal rows (approved, rejected, completed,
 * failed, cancelled) are never touched — a failed run stays failed as retry
 * evidence. Runs inside the caller's transaction (submit, allocation post,
 * bank submit all dispatch under their own unit), so a caller that then
 * throws rolls the dispatch back entirely instead.
 */
export async function cancelDispatchRuns(
  orgId: string,
  runIds: string[],
  opts?: { runner?: SqlRunner; actorId?: string | null },
): Promise<void> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return;
  const runner: SqlRunner = opts?.runner ?? db;
  const actorId = opts?.actorId ?? null;
  await runner.execute(sql`
    update flow_gates set status = 'cancelled', updated_at = now()
      ${actorId ? sql`, updated_by = ${actorId}` : sql``}
     where run_id in (
       select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid
     ) and org_id = ${orgId} and status in ('pending', 'escalated')
  `);
  await runner.execute(sql`
    update flow_runs set status = 'cancelled', finished_at = now(), updated_at = now()
      ${actorId ? sql`, updated_by = ${actorId}` : sql``}
     where id in (
       select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid
     ) and org_id = ${orgId} and status in ('running', 'waiting')
  `);
}
