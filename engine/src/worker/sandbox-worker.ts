import { Worker } from "bullmq";
import { getBlockingConnection, SANDBOX_QUEUE, type SandboxJobData } from "@openbooks/jobs";
import { createSandbox, deleteSandbox, refreshSandbox, resetSandbox } from "../sandbox/lifecycle.ts";

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
      const d = job.data;
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
    },
    { connection: getBlockingConnection(), concurrency: 1 },
  );
}
