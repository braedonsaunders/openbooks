/** Point-of-sale refusal codes. Each reaches the register with its remedy. */
export type PosRefusalCode =
  | "feature_disabled"
  | "register_not_found"
  | "register_inactive"
  | "register_misconfigured"
  | "session_not_found"
  | "session_already_open"
  | "session_not_open"
  | "session_register_mismatch"
  | "invalid_input"
  | "item_not_found"
  | "item_unpriced"
  | "price_override_not_permitted"
  | "discount_not_permitted"
  | "tender_not_accepted"
  | "tender_mismatch"
  | "total_changed"
  | "cash_insufficient"
  | "stored_value_unknown"
  | "approval_required"
  | "refund_source_invalid"
  | "refund_exceeds_sale"
  | "reason_not_found"
  | "count_invalid"
  | "idempotency_conflict"
  | "held_cart_not_found";

/** A typed register refusal: a 4xx with a stable code and an operator remedy. */
export class PosError extends Error {
  readonly name = "PosError";

  constructor(
    message: string,
    readonly code: PosRefusalCode,
    readonly status: 404 | 409 | 422,
    readonly remedy: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function posRefusal(
  message: string,
  code: PosRefusalCode,
  status: 404 | 409 | 422,
  remedy: string,
  details?: Record<string, unknown>,
): PosError {
  return new PosError(message, code, status, remedy, details);
}
