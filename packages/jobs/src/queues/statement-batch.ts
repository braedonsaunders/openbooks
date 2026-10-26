import { Queue, type JobsOptions } from "bullmq";
import { getConnection } from "../connection";

export const STATEMENT_BATCH_QUEUE = "statement-batch";

/**
 * One batched customer statement: render that customer's statement PDF for
 * the run's period and email it through the native delivery. One job per
 * (run, customer); the deterministic job id below makes a repeated enqueue
 * of the same intent collapse instead of double-sending.
 */
export type StatementBatchJobData = {
  orgId: string;
  runId: string;
  partyId: string;
  /** The user who created the run; the worker re-resolves their grants. */
  senderId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertScope(label: string, value: string): void {
  if (!UUID.test(value)) throw new Error(`statement batch jobs require a valid ${label} id`);
}

/** Deterministic queue identity per (run, customer): retries dedupe. */
export function statementBatchJobId(input: { runId: string; partyId: string }): string {
  assertScope("run", input.runId);
  assertScope("customer", input.partyId);
  return `statement-batch|${input.runId}|${input.partyId}`;
}

/**
 * Email delivery scope for one run. The per-customer mailbox folds in at
 * derivation, so a retried job lands on the same email_log row (never a
 * second send) while a later run for the same customer mints a fresh row.
 */
export function statementBatchEmailScope(runId: string): string {
  assertScope("run", runId);
  return `statement-batch|${runId}`;
}

export function assertStatementBatchJob(data: StatementBatchJobData): void {
  assertScope("organization", data.orgId);
  assertScope("run", data.runId);
  assertScope("customer", data.partyId);
  if (!data.senderId.trim()) throw new Error("statement batch jobs require the sending user");
}

let statementBatchQueue: Queue<StatementBatchJobData> | undefined;

function getStatementBatchQueue(): Queue<StatementBatchJobData> {
  statementBatchQueue ??= new Queue<StatementBatchJobData>(STATEMENT_BATCH_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
  return statementBatchQueue;
}

/** Enqueue one job per customer; the job id dedupes repeated enqueues. */
export async function enqueueStatementBatchJobs(
  jobs: StatementBatchJobData[],
  options?: JobsOptions,
) {
  for (const job of jobs) assertStatementBatchJob(job);
  const queue = getStatementBatchQueue();
  return queue.addBulk(
    jobs.map((data) => ({
      name: "send",
      data,
      opts: { ...options, jobId: statementBatchJobId(data) },
    })),
  );
}
