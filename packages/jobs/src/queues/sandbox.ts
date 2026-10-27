import { Queue, type JobsOptions } from "bullmq";
import { getConnection } from "../connection";

export const SANDBOX_QUEUE = "sandbox";

export type SandboxJobInitiator =
  { actorId: string; systemReason?: never } | { actorId?: null; systemReason: string };

/**
 * One sandbox lifecycle operation, run asynchronously so a create/refresh that
 * copies a large tenant doesn't block the request. `op` selects the action;
 * `sandboxId` is present for refresh/reset/delete, absent for create (which
 * carries the create payload).
 */
export type SandboxJobData =
  | {
      op: "create";
      productionOrgId: string;
      name: string;
      tier: "dev" | "masked" | "full" | "as_of";
      masked: boolean;
      asOfPeriodId?: string | null;
      createdBy?: string | null;
      initiator: SandboxJobInitiator;
    }
  | {
      op: "refresh";
      sandboxId: string;
      keepCustomizations: boolean;
      initiator: SandboxJobInitiator;
    }
  | { op: "reset"; sandboxId: string; initiator: SandboxJobInitiator }
  | { op: "delete"; sandboxId: string; initiator: SandboxJobInitiator };

let sandboxQueue: Queue<SandboxJobData> | undefined;

export function getSandboxQueue(): Queue<SandboxJobData> {
  sandboxQueue ??= new Queue<SandboxJobData>(SANDBOX_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      // Clone/refresh are not safe to blindly retry (partial state); surface
      // failure via the sandbox row's status instead.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
  return sandboxQueue;
}

export async function enqueueSandboxOp(data: SandboxJobData, options?: JobsOptions) {
  return getSandboxQueue().add(data.op, data, options);
}

/** A create that is queued or running but may not have its sandbox row yet. */
export interface PendingSandboxCreate {
  jobId: string;
  name: string;
  tier: "dev" | "masked" | "full" | "as_of";
  masked: boolean;
  queuedAt: string;
  state: "queued" | "active";
}

/**
 * Creates for one production organization that the worker has not finished.
 * The sandbox row is written only once the worker starts the clone, so the
 * queue is the record of a create between submission and provisioning.
 */
export async function listPendingSandboxCreates(
  productionOrgId: string,
): Promise<PendingSandboxCreate[]> {
  const jobs = await getSandboxQueue().getJobs(["active", "waiting", "paused", "delayed"], 0, 199);
  const pending: PendingSandboxCreate[] = [];
  for (const job of jobs) {
    const data = job.data;
    if (!job.id || data.op !== "create" || data.productionOrgId !== productionOrgId) continue;
    pending.push({
      jobId: job.id,
      name: data.name,
      tier: data.tier,
      masked: data.masked,
      queuedAt: new Date(job.timestamp).toISOString(),
      state: (await job.isActive()) ? "active" : "queued",
    });
  }
  return pending.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
}
