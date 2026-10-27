import { Queue, type Job } from "bullmq";
import { getConnection } from "../connection";

export const SAMPLE_COMPANY_QUEUE = "sample-company";

/**
 * One member's request for an industry sample company. Preparing the
 * template and copying its posted history takes minutes, so the worker runs
 * it and the web request only starts it. The pipeline itself is idempotent
 * per member and industry; the job identity below additionally keeps at most
 * one run of that request queued or running at a time.
 */
export type SampleCompanyJobData = {
  industryKey: string;
  memberUserId: string;
  sourceOrgId: string;
  memberName: string;
};

export type SampleCompanyJobStage = "template" | "clone" | "finalize" | "numbering";

/** The operator-facing failure body a failed run records, with its support reference. */
export type SampleCompanyJobFailure = {
  error?: string;
  stage?: SampleCompanyJobStage;
  message?: string;
  requestId: string;
};

/** What a run publishes as its progress: the running stage, then any failure body. */
export type SampleCompanyJobProgress = {
  stage: SampleCompanyJobStage | null;
  failure?: SampleCompanyJobFailure;
};

export type SampleCompanyJobStatus =
  | { state: "queued" | "running"; stage: SampleCompanyJobStage | null }
  | { state: "failed"; failure: SampleCompanyJobFailure | null }
  | { state: "completed"; orgId: string | null };

let sampleCompanyQueue: Queue<SampleCompanyJobData> | undefined;

export function getSampleCompanyQueue(): Queue<SampleCompanyJobData> {
  sampleCompanyQueue ??= new Queue<SampleCompanyJobData>(SAMPLE_COMPANY_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      // A failed run reports its staged outcome; a new request resumes or
      // compensates through the pipeline instead of blindly replaying it.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return sampleCompanyQueue;
}

/** Deterministic identity of one member's request for one industry. */
export function sampleCompanyJobId(memberUserId: string, industryKey: string): string {
  return `sample-company|${memberUserId}|${industryKey}`;
}

const STAGES = new Set<string>(["template", "clone", "finalize", "numbering"]);

function stageOf(value: unknown): SampleCompanyJobStage | null {
  return typeof value === "string" && STAGES.has(value) ? (value as SampleCompanyJobStage) : null;
}

function failureOf(value: unknown): SampleCompanyJobFailure | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string") return null;
  const failure: SampleCompanyJobFailure = { requestId: record.requestId };
  if (typeof record.error === "string") failure.error = record.error;
  const stage = stageOf(record.stage);
  if (stage) failure.stage = stage;
  if (typeof record.message === "string") failure.message = record.message;
  return failure;
}

/** Read a run's status from its queue state and published progress. */
export function sampleCompanyJobStatus(
  job: Pick<Job, "progress" | "returnvalue">,
  state: string,
): SampleCompanyJobStatus | null {
  const progress =
    job.progress !== null && typeof job.progress === "object" && !Array.isArray(job.progress)
      ? (job.progress as Record<string, unknown>)
      : {};
  switch (state) {
    case "active":
      return { state: "running", stage: stageOf(progress.stage) };
    case "waiting":
    case "waiting-children":
    case "delayed":
    case "prioritized":
      return { state: "queued", stage: stageOf(progress.stage) };
    case "failed":
      return { state: "failed", failure: failureOf(progress.failure) };
    case "completed": {
      const result = job.returnvalue as { orgId?: unknown } | null | undefined;
      return {
        state: "completed",
        orgId: typeof result?.orgId === "string" ? result.orgId : null,
      };
    }
    default:
      return null;
  }
}

/** The status of the member's latest run for an industry, or null when none is recorded. */
export async function readSampleCompanyJob(
  memberUserId: string,
  industryKey: string,
): Promise<SampleCompanyJobStatus | null> {
  const job = await getSampleCompanyQueue().getJob(sampleCompanyJobId(memberUserId, industryKey));
  if (!job) return null;
  return sampleCompanyJobStatus(job, await job.getState());
}

/**
 * Start the member's run for an industry, or report the run already queued
 * or running. A finished run is history: its record is replaced by the new
 * run, which resumes or compensates any partial company through the
 * pipeline. Concurrent starts share one run through the job identity.
 */
export async function startSampleCompanyJob(
  data: SampleCompanyJobData,
): Promise<SampleCompanyJobStatus> {
  const queue = getSampleCompanyQueue();
  const jobId = sampleCompanyJobId(data.memberUserId, data.industryKey);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const status = sampleCompanyJobStatus(existing, await existing.getState());
    if (status && (status.state === "queued" || status.state === "running")) return status;
    await existing.remove();
  }
  const job = await queue.add("provision", data, { jobId });
  return (
    sampleCompanyJobStatus(job, await job.getState()) ?? {
      state: "queued",
      stage: null,
    }
  );
}
