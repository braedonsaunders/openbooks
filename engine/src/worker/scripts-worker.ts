import { Worker } from "bullmq";
import { SCRIPTS_QUEUE, getBlockingConnection, type ScriptJobData } from "@openbooks/jobs";
import { runBulkScript, runScheduledScript } from "../scripting.ts";

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
      const d = job.data;
      const outcome =
        d.kind === "bulk"
          ? await runBulkScript(d.scriptId, d.orgId)
          : await runScheduledScript(d.scriptId, d.orgId);
      return { status: outcome.status, durationMs: outcome.durationMs };
    },
    { connection: getBlockingConnection(), concurrency: 4 },
  );
}
