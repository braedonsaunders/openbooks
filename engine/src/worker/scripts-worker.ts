import { Worker } from "bullmq";
import { SCRIPTS_QUEUE, getBlockingConnection, type ScriptJobData } from "@openbooks/jobs";
import { withOrgContext } from "../platform/db.ts";
import { runBulkScript, runScheduledScript, type ScriptOutcome } from "../scripting/scripting.ts";
import { bulkRunIdempotencyScope, claimBulkRunExecution, completeBulkRunKey } from "../scripting/bulk-run-claim.ts";

/**
 * Execute one `scripts` queue payload — the exact code the worker callback
 * runs, extracted (same function, no shadow) so tests can drive a real
 * payload through it against live Postgres without standing up Redis.
 *
 * Attribution contract: d.actorId is present only on jobs queued by an
 * interactive "Run now"; it is forwarded into the runner, which re-resolves
 * it against users and stamps script_runs.created_by plus any journal actor.
 * Cron ticks enqueue payloads without actorId, so system automation stays
 * explicitly null-provenanced at this same shared boundary.
 *
 * Occurrence contract: a scheduled payload carries the scheduler's immutable
 * occurrenceKey, forwarded as the run's journal idempotency scope so a
 * recovery retry of the same occurrence replays instead of double-posting
 * (SCHED1). Jobs enqueued before the key existed carry no scope in the
 * payload, but their BullMQ job id IS the scheduler-minted occurrence key
 * (attempt 1) or that key with a `:rN` retry suffix — adopt it when it is
 * recognizably one, otherwise fall back to the run's minute bucket.
 * The payload's occurrenceRunId is forwarded alongside, linking the run row
 * to its dispatch-ledger row for one-to-one recovery (SCHED2).
 */
export function scheduledScopeFromJob(
  kind: ScriptJobData["kind"],
  data: Pick<ScriptJobData, "occurrenceKey">,
  jobId?: string,
): string | undefined {
  if (data.occurrenceKey) return data.occurrenceKey;
  if (kind === "scheduled" && jobId) {
    const scope = jobId.replace(/:r\d+$/, "");
    if (scope.startsWith("sched|")) return scope;
  }
  return undefined;
}

export async function processScriptJobData(
  d: ScriptJobData,
  jobMeta?: { jobId?: string },
): Promise<ScriptOutcome> {
  // A queue handler runs in a bare callback with no request store, so the
  // job's own tenant is the only legal scope for its queries. Without it the
  // connection layer denies by default and the script reads an empty org.
  const outcome = await withOrgContext(d.orgId, () =>
    d.kind === "bulk"
      ? runBulkScriptClaimed(d)
      : runScheduledScript(d.scriptId, d.orgId, {
          actorId: d.actorId ?? null,
          idempotencyScope: scheduledScopeFromJob(d.kind, d, jobMeta?.jobId),
          occurrenceRunId: d.occurrenceRunId,
        }),
  );
  return outcome;
}

/**
 * Bulk runs execute under the caller's run-key claim (E02). A redelivered
 * duplicate whose claim already completed reconciles onto the recorded
 * outcome without executing the script again; the election lets exactly one
 * live delivery own the execution, and that execution reuses the claim's
 * stable journal scope so even a crash-takeover replays instead of
 * double-posting. A rival racing a live execution refuses loudly — a failed
 * job the operator can see — instead of silently posting twice. Jobs without
 * a key (scheduled kinds never reach here; pre-key Run-now jobs) run
 * unclaimed, as before.
 */
async function runBulkScriptClaimed(d: ScriptJobData): Promise<ScriptOutcome> {
  const key = d.idempotencyKey;
  const actorId = d.actorId ?? null;
  if (!key || !actorId) {
    return runBulkScript(d.scriptId, d.orgId, { actorId });
  }
  const execution = await claimBulkRunExecution({ orgId: d.orgId, actorId, scriptId: d.scriptId, key });
  if (execution.status === "completed") {
    return execution.response as ScriptOutcome;
  }
  if (execution.status === "mismatched") {
    throw new Error(
      `bulk run key is already bound to a different script — refusing to execute script ${d.scriptId} under it`,
    );
  }
  if (execution.status === "inflight") {
    throw new Error(
      "this bulk run is already in progress — refusing duplicate execution; " +
        "retry with the same key after it completes to replay the recorded outcome",
    );
  }
  const outcome = await runBulkScript(d.scriptId, d.orgId, { actorId, idempotencyScope: bulkRunIdempotencyScope(key) });
  await completeBulkRunKey({ orgId: d.orgId, actorId, scriptId: d.scriptId, key, response: outcome });
  return outcome;
}

/**
 * Consumes the `scripts` queue: scheduled (cron ticks handed off by the in-app
 * scheduler) and bulk (long-budget "Run now" jobs). The runners write their own
 * script_runs rows — success AND script-level failure both land in the audit
 * trail; only host-side crashes surface as BullMQ job failures.
 */
export function createScriptsWorker(): Worker<ScriptJobData> {
  return new Worker<ScriptJobData>(
    SCRIPTS_QUEUE,
    async (job) => {
      const outcome = await processScriptJobData(job.data, { jobId: job.id });
      // Only the compact evidence blob rides the job return value; the full
      // audit trail lives in script_runs.
      return { status: outcome.status, durationMs: outcome.durationMs };
    },
    {
      connection: getBlockingConnection(),
      concurrency: 4,
      // A bulk run legitimately holds its processing lock up to BULK_TIMEOUT_MS
      // (30 s); the 30 s default lockDuration therefore stall-redelivers
      // healthy runs. Hold the lock well past any legitimate run (script
      // budgets top out at the 30 s bulk budget) so a redelivery means a
      // crashed worker, not a slow one.
      lockDuration: 60_000,
    },
  );
}

