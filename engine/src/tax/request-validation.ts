/**
 * Request-state validation refusal for tax setup reads and installs. The
 * nexus ledger and pack provisioning signal operator-correctable input,
 * state and version drift with curated text; the API boundary maps this
 * class to a 422 with that message instead of collapsing it into a 500.
 * Internal invariants stay plain Error and remain 500.
 */
export class TaxRequestValidationError extends Error {
  readonly name = 'TaxRequestValidationError'
  readonly status = 422
}
