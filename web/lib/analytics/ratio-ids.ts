/**
 * The Financial Health ratio vocabulary, shared by the engine, the catalog
 * strings, the dashboard and the home-dashboard widgets. Pure on purpose.
 */
export const RATIO_IDS = [
  "gross_margin", "operating_margin", "ebitda_margin", "net_margin", "roa", "roe", "roic", "roce",
  "current_ratio", "quick_ratio", "working_capital",
  "debt_to_equity", "liabilities_to_equity", "interest_coverage",
  "rev_per_employee", "gp_per_employee", "asset_turnover",
  "cogs_ratio", "opex_ratio", "operating_leverage", "rule_of_40",
] as const;
export type RatioId = (typeof RATIO_IDS)[number];

export type RatioCategory = "profitability" | "liquidity" | "solvency" | "efficiency" | "operating";
export const RATIO_CATEGORIES: readonly RatioCategory[] = ["profitability", "liquidity", "solvency", "efficiency", "operating"];

/** pct = a fraction (0.25 = 25%); times = a multiple (1.80×); points = a plain score; money = an amount. */
export type RatioFormat = "pct" | "times" | "points" | "money";
export type Grade = "A" | "B" | "C" | "D" | "F";
