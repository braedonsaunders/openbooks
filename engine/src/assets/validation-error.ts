/**
 * Request-state validation refusal for fixed-asset writes. The asset
 * change, group valuation and tax-pack installers signal operator-
 * correctable input and state with curated text; the API boundary maps
 * this class to a 422 with that message instead of collapsing it into a
 * 500. Internal invariants stay plain Error and remain 500.
 */
export class AssetValidationError extends Error {
  readonly name = 'AssetValidationError'
  readonly status = 422
}
