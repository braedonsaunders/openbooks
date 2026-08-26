import { Worker } from "bullmq";
import { SCRIPTS_QUEUE, getBlockingConnection, type ScriptJobData } from "@openbooks/jobs";
import { withOrgContext } from "../db.ts";
import { runBulkScript, runScheduledScript, type ScriptOutcome } from "../scripting.ts";

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
 */
export async function processScriptJobData(d: ScriptJobData): Promise<ScriptOutcome> {
  // A queue handler runs in a bare callback with no request store, so the
  // job's own tenant is the only legal scope for its queries. Without it the
  // connection layer denies by default and the script reads an empty org.
  const outcome = await withOrgContext(
    d.orgId,
    () =>
      d.kind === "bulk"
        ? runBulkScript(d.scriptId, d.orgId, { actorId: d.actorId ?? null })
        : runScheduledScript(d.scriptId, d.orgId, { actorId: d.actorId ?? null }),
  );
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
      const outcome = await processScriptJobData(job.data);
      // Only the compact evidence blob rides the job return value; the full
      // audit trail lives in script_runs.
      return { status: outcome.status, durationMs: outcome.durationMs };
    },
    { connection: getBlockingConnection(), concurrency: 4 },
  );
}

