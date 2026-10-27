import { isUuid } from "./list-params";
import { refusalMessageFromBody } from "./api-error";

export interface SampleCompanyRefusal {
  code?: string;
  stage?: string;
  message?: string;
  requestId?: string;
  status?: number;
  /**
   * The outcome is known: either nothing was started, or the recorded run has
   * finished with this failure. Another attempt may be requested; it replaces
   * the finished run and resumes or compensates any partial company. Absent
   * when the outcome is unconfirmed or the failure needs support first.
   */
  retryable?: boolean;
}

/** Refusals given before any preparation started. */
const NOT_STARTED_CODES = new Set([
  "sample-company-worker-unavailable",
  "sample-company-queue-unavailable",
]);

/** A previous attempt left an organization that must be removed before another attempt. */
export const SAMPLE_COMPANY_STRANDED_ORG_CODE = "sample-company-stranded-org";

export type SampleCompanyStage = "template" | "clone" | "finalize" | "numbering";

/** A provisioning run still in progress, as the background worker reports it. */
export interface SampleCompanyRun {
  state: "queued" | "running";
  stage: SampleCompanyStage | null;
}

export type SampleCompanyResponse =
  | { ok: true; orgId: string; created: boolean }
  | { ok: true; run: SampleCompanyRun }
  | { ok: false; refusal: SampleCompanyRefusal };

/**
 * One status read while a run is in progress. `unavailable` means this read
 * proved nothing (a dropped connection or an unavailable server); the
 * caller keeps watching rather than reporting an outcome.
 */
export type SampleCompanyStatusRead =
  | { kind: "ready"; orgId: string }
  | { kind: "running"; run: SampleCompanyRun }
  | { kind: "failed"; refusal: SampleCompanyRefusal }
  | { kind: "unavailable" };

const STAGES = new Set<string>(["template", "clone", "finalize", "numbering"]);

function asRecord(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** A queued or running run from a server status body; anything else is not a run. */
export function sampleCompanyRun(value: unknown): SampleCompanyRun | null {
  const record = asRecord(value);
  if (!record || (record.state !== "queued" && record.state !== "running")) return null;
  const stage =
    typeof record.stage === "string" && STAGES.has(record.stage)
      ? (record.stage as SampleCompanyStage)
      : null;
  return { state: record.state, stage };
}

/**
 * The recorded failure of a finished run, read like a refusal body. The run
 * is known to have ended, so another attempt may be offered — except when it
 * stranded an organization that support must remove first.
 */
function failedRun(value: unknown): SampleCompanyRefusal | null {
  const record = asRecord(value);
  if (!record || record.state !== "failed") return null;
  const refusal = sampleCompanyRefusal(record.failure, null);
  return refusal.code === SAMPLE_COMPANY_STRANDED_ORG_CODE
    ? refusal
    : { ...refusal, retryable: true };
}

/** A stage identifies where execution stopped, not whether a company exists. */
export async function readSampleCompanyResponse(
  response: Response,
): Promise<SampleCompanyResponse> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    return { ok: false, refusal: sampleCompanyRefusal(body, response) };
  }
  const record = asRecord(await response.json().catch(() => null));
  if (record) {
    if (isUuid(record.orgId) && typeof record.created === "boolean") {
      return { ok: true, orgId: record.orgId, created: record.created };
    }
    const run = sampleCompanyRun(record.provisioning);
    if (run) return { ok: true, run };
    const failure = failedRun(record.provisioning);
    if (failure) return { ok: false, refusal: failure };
  }
  // A malformed success cannot establish a workspace identity or justify a
  // second provisioning request. Its outcome stays unconfirmed.
  return { ok: false, refusal: sampleCompanyRefusal(null, response) };
}

/**
 * What a sample-company status body says: a ready company wins, then a run in
 * progress, then a recorded failure; `idle` means neither a company nor a
 * run is recorded.
 */
export function sampleCompanyStatusFromBody(
  body: unknown,
): Exclude<SampleCompanyStatusRead, { kind: "unavailable" }> | { kind: "idle" } {
  const record = asRecord(body) ?? {};
  if (isUuid(record.existingOrgId)) return { kind: "ready", orgId: record.existingOrgId };
  const run = sampleCompanyRun(record.provisioning);
  if (run) return { kind: "running", run };
  const failure = failedRun(record.provisioning);
  if (failure) return { kind: "failed", refusal: failure };
  return { kind: "idle" };
}

/**
 * Read one poll of `GET /api/data/sample-companies?industry=`. While a run
 * is being watched, a read that shows neither a company nor a run leaves
 * readiness unconfirmed rather than implying the run never happened.
 */
export async function readSampleCompanyStatus(
  response: Response,
): Promise<SampleCompanyStatusRead> {
  if (!response.ok) {
    if (response.status >= 500) return { kind: "unavailable" };
    const body: unknown = await response.json().catch(() => null);
    return { kind: "failed", refusal: sampleCompanyRefusal(body, response) };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!asRecord(body)) return { kind: "unavailable" };
  const read = sampleCompanyStatusFromBody(body);
  return read.kind === "idle" ? { kind: "failed", refusal: { status: response.status } } : read;
}

function sampleCompanyRefusal(body: unknown, response: Response | null): SampleCompanyRefusal {
  const record = asRecord(body) ?? {};
  const error = typeof record.error === "string" ? record.error.trim() : undefined;
  const code = error?.startsWith("sample-company-") ? error : undefined;
  const message =
    refusalMessageFromBody(
      { ...record, error: code ? undefined : record.error },
      { fallback: "" },
    ) ?? undefined;
  const requestId = record.requestId ?? response?.headers.get("x-request-id");
  return {
    code,
    stage: typeof record.stage === "string" ? record.stage : undefined,
    message,
    requestId: isUuid(requestId) ? requestId : undefined,
    ...(response ? { status: response.status } : {}),
    ...(code && NOT_STARTED_CODES.has(code) ? { retryable: true } : {}),
  };
}
