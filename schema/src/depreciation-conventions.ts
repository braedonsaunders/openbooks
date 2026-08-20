/**
 * First-period depreciation conventions — the single vocabulary.
 *
 * OpenBooks runs two depreciation engines on purpose, because book and tax
 * depreciation are different computations for different readers and their
 * DIFFERENCE is the deferred-tax temporary difference:
 *
 *   - the BOOK engine (engine/src/depreciation.ts) is per-asset, monthly, and
 *     posts to the general ledger;
 *   - the TAX engine (engine/src/tax-depreciation-pool.ts) is per class pool or
 *     MACRS class, annual, never touches the ledger, and owns recapture,
 *     terminal loss and immediate expensing.
 *
 * What they must NOT do is disagree about what a convention MEANS. They used to
 * declare these names in two unrelated inline enums and implement them twice:
 * the tax engine read `half_year` as half of a YEAR (correct) while the book
 * engine read it as half of one monthly PERIOD, so an asset on the half-year
 * convention recognised about 11.5 months of expense in its first year instead
 * of six. Nothing could catch that, because nothing connected the two spellings.
 *
 * The names live here, once. Semantics live in
 * engine/src/depreciation-conventions.ts, which is the only place either engine
 * may derive a first-year fraction from.
 *
 * These tuples are ALSO the source of each column's CHECK constraint, so their
 * values and ORDER are part of the generated migration. Reordering or renaming
 * is a schema change, not a refactor.
 */

/**
 * Conventions the book engine can express. Its period is a calendar month, so
 * `full_month` (the whole in-service month counts) is meaningful here and the
 * date-dependent MACRS conventions are not.
 */
export const BOOK_DEPRECIATION_CONVENTIONS = [
  "full_month",
  "mid_month",
  "half_year",
] as const;

/**
 * Conventions the tax engine can express. MACRS adds `mid_quarter`, which the
 * book engine has no representation for; there is deliberately no `full_month`,
 * because a tax year is not a month.
 */
export const TAX_DEPRECIATION_CONVENTIONS = [
  "half_year",
  "mid_quarter",
  "mid_month",
] as const;

export type BookDepreciationConvention = (typeof BOOK_DEPRECIATION_CONVENTIONS)[number];
export type TaxDepreciationConvention = (typeof TAX_DEPRECIATION_CONVENTIONS)[number];

/** Every convention either engine can express. */
export type DepreciationConvention =
  | BookDepreciationConvention
  | TaxDepreciationConvention;

/**
 * Conventions whose first-year share is fixed by the rule itself rather than by
 * the in-service date. These are the ones both engines must agree on exactly —
 * see the cross-engine test in engine/src/depreciation-conventions.test.ts.
 */
export const DATE_INDEPENDENT_CONVENTIONS = ["full_month", "half_year"] as const;
