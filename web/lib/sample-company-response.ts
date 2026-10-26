import { isUuid } from "./list-params";
import { refusalMessageFromBody } from "./api-error";

export interface SampleCompanyRefusal {
  code?: string;
  stage?: string;
  message?: string;
  requestId?: string;
  status?: number;
}

export type SampleCompanyResponse =
  { ok: true; orgId: string; created: boolean } | { ok: false; refusal: SampleCompanyRefusal };

/** A stage identifies where execution stopped, not whether a company exists. */
export async function readSampleCompanyResponse(
  response: Response,
): Promise<SampleCompanyResponse> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    return { ok: false, refusal: sampleCompanyRefusal(body, response) };
  }
  const body: unknown = await response.json().catch(() => null);
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (isUuid(record.orgId) && typeof record.created === "boolean") {
      return { ok: true, orgId: record.orgId, created: record.created };
    }
  }
  // A malformed success cannot establish a workspace identity or justify a
  // second provisioning request. Its outcome stays unconfirmed.
  return { ok: false, refusal: sampleCompanyRefusal(null, response) };
}

function sampleCompanyRefusal(body: unknown, response: Response): SampleCompanyRefusal {
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const error = typeof record.error === "string" ? record.error.trim() : undefined;
  const code = error?.startsWith("sample-company-") ? error : undefined;
  const message =
    refusalMessageFromBody(
      { ...record, error: code ? undefined : record.error },
      { fallback: "" },
    ) ?? undefined;
  const requestId = record.requestId ?? response.headers.get("x-request-id");
  return {
    code,
    stage: typeof record.stage === "string" ? record.stage : undefined,
    message,
    requestId: isUuid(requestId) ? requestId : undefined,
    status: response.status,
  };
}
