/**
 * HR-19 documents, retention, DSAR, surveys, and org-chart errors.
 *
 * One error class per area, coded refusals with the remedy named. Every
 * code maps to an HTTP status at the API boundary (see the route `_lib`
 * helpers): NOT_FOUND → 404, REFUSED → 422, VALIDATION → 400. A refusal
 * computed here must reach the caller — never swallowed into `{ok}`.
 */
export class HrmDocumentsError extends Error {
  readonly name = "HrmDocumentsError";
  constructor(
    readonly code: "NOT_FOUND" | "REFUSED" | "VALIDATION" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
  }
}

export class HrmSurveysError extends Error {
  readonly name = "HrmSurveysError";
  constructor(
    readonly code: "NOT_FOUND" | "REFUSED" | "VALIDATION" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
  }
}

export class HrmOrgChartError extends Error {
  readonly name = "HrmOrgChartError";
  constructor(
    readonly code: "NOT_FOUND" | "REFUSED" | "VALIDATION",
    message: string,
  ) {
    super(message);
  }
}
