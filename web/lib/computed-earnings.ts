/**
 * Synthetic equity lines the statements add because income accounts stay
 * open forever. Prior-year net income is not posted to retained earnings, so
 * these ids are the report-layer placeholders that stand in for it — the
 * automatic year-end close that ledgers which roll income into equity would
 * have journalled, computed at read time instead of posted.
 */
export const COMPUTED_RETAINED_EARNINGS_PRIOR_ID = "computed-retained-earnings-prior";
export const COMPUTED_CURRENT_YEAR_EARNINGS_ID = "computed-current-year-earnings";
export const COMPUTED_RETAINED_EARNINGS_PRIOR_NAME = "Retained earnings (prior years)";
export const COMPUTED_CURRENT_YEAR_EARNINGS_NAME = "Current year earnings";
