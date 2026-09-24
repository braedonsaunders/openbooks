import { Worker } from "bullmq";
import { SCRIPTS_QUEUE, getBlockingConnection, type ScriptJobData } from "@openbooks/jobs";
import { withOrgContext } from "../platform/db.ts";
import { runBulkScript, runScheduledScript, type ScriptOutcome } from "../scripting/scripting.ts";
import { completeBulkRunKey, readBulkRunClaim } from "../scripting/bulk-run-claim.ts";

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
 * outcome without executing the script again; anything else runs and then
 * completes the claim idempotently. Jobs without a key (scheduled kinds
 * never reach here; pre-key Run-now jobs) run unclaimed, as before.
 */
async function runBulkScriptClaimed(d: ScriptJobData): Promise<ScriptOutcome> {
  const key = d.idempotencyKey;
  const actorId = d.actorId ?? null;
  if (!key || !actorId) {
    return runBulkScript(d.scriptId, d.orgId, { actorId });
  }
  const claim = await readBulkRunClaim({ orgId: d.orgId, actorId, scriptId: d.scriptId, key });
  if (claim.status === "completed") {
    return claim.response as ScriptOutcome;
  }
  const outcome = await runBulkScript(d.scriptId, d.orgId, { actorId });
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
    { connection: getBlockingConnection(), concurrency: 4 },
  );
}

