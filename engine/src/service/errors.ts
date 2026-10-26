/**
 * The service dispatch refusal. Every refusal names what is wrong and the
 * supported remedy; route boundaries carry `code` and `remedy` unchanged.
 */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly remedy?: string;
  /** Conflicts an assignment met, when the refusal is an assignment check. */
  readonly conflicts?: readonly unknown[];
  /** Structured refusal evidence the API boundary returns with the message. */
  readonly details?: { readonly conflicts: readonly unknown[] };
  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      remedy?: string;
      cause?: unknown;
      conflicts?: readonly unknown[];
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ServiceError";
    this.status = options.status ?? 422;
    this.code = options.code ?? "service_refused";
    if (options.remedy) this.remedy = options.remedy;
    if (options.conflicts) {
      this.conflicts = options.conflicts;
      this.details = { conflicts: options.conflicts };
    }
  }
}

const UNIQUE_REFUSALS: Record<string, readonly [string, string]> = {
  service_dispatch_policies_org_id_effective_from_key: [
    "A dispatch policy version already starts on this date.",
    "Choose a later effective date for the new version.",
  ],
  service_agreement_versions_org_id_agreement_id_effective_from_key: [
    "An agreement version already starts on this date.",
    "Choose a later effective date for the new version.",
  ],
  service_jobs_one_per_request: [
    "This request was already converted to a job.",
    "Open the job created from the request.",
  ],
  service_jobs_one_per_agreement: ["This agreement already has its job.", "Reload the agreement."],
  service_quotes_org_id_quote_document_id_key: [
    "This estimate already carries service terms.",
    "Open the service quote attached to the estimate.",
  ],
  service_visit_signature_requests_open: [
    "This visit already has an open signing link.",
    "Use or revoke the open link before issuing another.",
  ],
  service_visit_signatures_org_id_visit_id_key: [
    "The customer already signed this visit.",
    "A signature is recorded once.",
  ],
  service_billings_job_active: [
    "This job is already invoiced.",
    "Open its invoice; void it first to invoice the job again.",
  ],
  service_billings_visit_active: [
    "This visit is already invoiced.",
    "Open its invoice; void it first to invoice the visit again.",
  ],
  service_job_deposits_org_id_payment_document_id_key: [
    "This payment is already recorded as a deposit.",
    "Choose another payment.",
  ],
  schedule_entries_service_visit_worker: [
    "This technician is already assigned to the visit.",
    "Reload the dispatch board.",
  ],
  service_visits_occurrence_key: [
    "This agreement occurrence already has a visit.",
    "Reload the agreement.",
  ],
  signature_requests_open_subject_unique: [
    "A signature request is already open on this estimate.",
    "Void the open request before sending it again.",
  ],
};

type DatabaseCause = {
  code?: string;
  constraint?: string;
  message?: string;
  where?: string;
  cause?: unknown;
};

/**
 * Translate a database refusal raised by the service tables into operator
 * terms. Guard messages are already worded for operators; named constraints
 * are mapped here. Anything unrecognized is returned unchanged so the
 * original cause is preserved.
 */
export function serviceDatabaseRefusal(error: unknown): unknown {
  const seen = new Set<object>();
  let cause: unknown = error;
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    const detail = cause as DatabaseCause;
    if (
      (detail.code === "42P01" && /service_[a-z_]+/.test(detail.message ?? "")) ||
      (detail.code === "42703" && /service_visit_id/.test(detail.message ?? ""))
    ) {
      return new ServiceError(
        "Service dispatch needs its database upgrade before it can be used.",
        {
          status: 409,
          code: "service_upgrade_required",
          remedy: "Ask an administrator to apply the pending database migrations.",
        },
      );
    }
    if (
      (detail.code === "23514" || detail.code === "P0001") &&
      detail.message &&
      !detail.constraint &&
      /service_|schedule_entries_service_visit/.test(detail.where ?? "")
    ) {
      return new ServiceError(detail.message, { code: "service_refused" });
    }
    if (detail.code === "23505" && UNIQUE_REFUSALS[detail.constraint ?? ""]) {
      const [message, remedy] = UNIQUE_REFUSALS[detail.constraint!]!;
      return new ServiceError(message, { status: 409, code: "service_conflict", remedy });
    }
    if (detail.code === "23514" && detail.constraint?.startsWith("service_")) {
      return new ServiceError("The service record is not valid.", {
        code: "service_invalid",
        remedy: "Review the entered values and try again.",
        cause: error,
      });
    }
    if (detail.code === "23503" && detail.constraint?.startsWith("service_")) {
      return new ServiceError("A referenced record is not available in this organization.", {
        code: "service_reference_unavailable",
        remedy: "Reload and choose the customer, address, item or person again.",
      });
    }
    if (detail.code === "40001" || detail.code === "40P01") {
      return new ServiceError("The record changed while this was being saved.", {
        status: 409,
        code: "service_stale",
        remedy: "Reload and try again; nothing in this change was saved.",
      });
    }
    cause = detail.cause;
  }
  return error;
}

export function stale(what = "This record"): ServiceError {
  return new ServiceError(`${what} changed since it was loaded.`, {
    status: 409,
    code: "service_stale",
    remedy: "Reload it and make the change again.",
  });
}
