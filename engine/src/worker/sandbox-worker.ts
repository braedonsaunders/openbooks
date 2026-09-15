import { Worker } from "bullmq";
import { getBlockingConnection, SANDBOX_QUEUE, type SandboxJobData } from "@openbooks/jobs";
import { withBypassContext } from "../db.ts";
import { createSandbox, deleteSandbox, refreshSandbox, resetSandbox } from "../sandbox/lifecycle.ts";

/**
 * Execute one `sandbox` queue payload — the exact code the worker callback
 * runs, extracted (same function, no shadow) so tests can drive a real
 * payload through it against live Postgres without standing up Redis.
 *
 * Boundary contract: a sandbox operation spans TWO tenants (the production
 * source and the sandbox clone), so no single-tenant scope can cover it.
 * The whole operation crosses one explicit trusted boundary instead — the
 * same maintenance-grade boundary the mirror scheduler and the backup claim
 * use. A queue callback carries no request store and the worker process
 * registers no request resolver, so without this the connection layer
 * applies its deny-by-default GUCs and every entry read (orgs, sandboxes —
 * both FORCE RLS) returns zero rows: creates threw "production org not
 * found", refreshes threw "sandbox not found" (and even the failure-mark
 * UPDATE was denied, wedging scheduler-claimed rows in 'refreshing'
 * forever), and deletes returned success without deleting anything.
 */
export async function processSandboxJobData(d: SandboxJobData): Promise<unknown> {
  return await withBypassContext(async () => {
    switch (d.op) {
      case "create":
        return await createSandbox({
          productionOrgId: d.productionOrgId,
          name: d.name,
          tier: d.tier,
          masked: d.masked,
          asOfPeriodId: d.asOfPeriodId ?? null,
          createdBy: d.createdBy ?? null,
        });
      case "refresh":
        return await refreshSandbox(d.sandboxId, { keepCustomizations: d.keepCustomizations });
      case "reset":
        return await resetSandbox(d.sandboxId);
      case "delete":
        return await deleteSandbox(d.sandboxId);
    }
  });
}

/**
 * Consumes the `sandbox` queue: create / refresh / reset / delete run here so a
 * clone that copies a large tenant doesn't block a web request. Concurrency 1 —
 * clone/refresh are heavy, deferred-constraint transactions; serializing avoids
 * piling long transactions onto the pool.
 */
export function createSandboxWorker(): Worker<SandboxJobData> {
  return new Worker<SandboxJobData>(
    SANDBOX_QUEUE,
    async (job) => {
      // Queue callbacks carry no request store; the operation's own trusted
      // boundary is established inside processSandboxJobData.
      return await processSandboxJobData(job.data);
    },
    { connection: getBlockingConnection(), concurrency: 1 },
  );
}
