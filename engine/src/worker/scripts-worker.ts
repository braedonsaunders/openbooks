import { Worker } from "bullmq";
import { SCRIPTS_QUEUE, getBlockingConnection, type ScriptJobData } from "@openbooks/jobs";
import { withOrgContext } from "../db.ts";
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
      // A queue handler runs in a bare callback with no request store, so the
      // job's own tenant is the only legal scope for its queries. Without it the
      // connection layer denies by default and the script reads an empty org.
      const outcome = await withOrgContext(d.orgId, () =>
        d.kind === "bulk"
          ? runBulkScript(d.scriptId, d.orgId)
          : runScheduledScript(d.scriptId, d.orgId));
      return { status: outcome.status, durationMs: outcome.durationMs };
    },
    { connection: getBlockingConnection(), concurrency: 4 },
  );
}
