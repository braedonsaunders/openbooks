/** Customer portal refusals: computed, raised, and named with the remedy. */
export class PortalRefusal extends Error {
  readonly name = "PortalRefusal";

  constructor(
    message: string,
    readonly code: PortalRefusalCode,
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

export type PortalRefusalCode =
  | "feature_disabled"
  | "invalid_email"
  | "no_portal_account"
  | "rate_limited"
  | "invalid_link"
  | "link_expired"
  | "link_consumed"
  | "link_locked"
  | "not_found"
  | "invalid_input"
  | "wrong_state"
  | "no_draft_invoice"
  | "outside_return_window"
  | "return_reason_not_allowed"
  | "return_resolution_not_allowed"
  | "changed_concurrently";

export function portalRefusal(
  message: string,
  code: PortalRefusalCode,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429,
  remedy?: string,
): PortalRefusal {
  return new PortalRefusal(message, code, status, remedy);
}
