import { Worker } from "bullmq";
import {
  getBlockingConnection,
  SAMPLE_COMPANY_QUEUE,
  type SampleCompanyJobData,
  type SampleCompanyJobProgress,
} from "@openbooks/jobs";
import { runSampleCompanyProvisioning } from "../sample-companies/public.ts";

/**
 * Consumes the `sample-company` queue: each job provisions one member's
 * industry sample company through the domain pipeline and publishes its
 * stage as job progress, which the Company Setup panel and the setup wizard
 * poll. A failed run records its staged failure body in the same progress.
 *
 * Concurrency 2 — a run holds a per-member lock connection and copies a
 * template through long transactions, so a small bound keeps the pool
 * available while two members can still be served at once. The pipeline
 * opens its own explicit tenant and cross-organization boundaries.
 */
export function createSampleCompanyWorker(): Worker<SampleCompanyJobData> {
  return new Worker<SampleCompanyJobData>(
    SAMPLE_COMPANY_QUEUE,
    async (job) =>
      runSampleCompanyProvisioning(job.data, (progress: SampleCompanyJobProgress) =>
        job.updateProgress(progress),
      ),
    { connection: getBlockingConnection(), concurrency: 2 },
  );
}
