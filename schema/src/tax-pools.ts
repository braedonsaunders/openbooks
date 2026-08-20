import { boolean, date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { TAX_DEPRECIATION_CONVENTIONS } from "./depreciation-conventions";
import { auditColumns, id, money, orgRef } from "./helpers";
import { fxRate } from "./helpers";

/**
 * Tax depreciation POOLS (jurisdiction-neutral). A pool is a class of assets a
 * tax regime depreciates as one running balance (Canada CCA/UCC, UK writing-down
 * allowances, AU low-value pools). Runs on a tax BOOK, annually; the math lives
 * in engine/src/tax-depreciation-pool.ts. Not Canada-literal — `regime` +
 * `class_code` carry the jurisdiction; the class table is config data.
 */
export const taxDepreciationPools = pgTable(
  "tax_depreciation_pools",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    /** Regime code, e.g. "ca_cca". */
    regime: text("regime").notNull(),
    /** Regime class code, e.g. Canada "8" / "10.1". */
    classCode: text("class_code").notNull(),
    rate: fxRate("rate").notNull(),
    method: text("method", { enum: ["declining", "straight_line"] }).notNull().default("declining"),
    /** Isolated single-asset pool (e.g. Canada separate-class election, Class 10.1). */
    isSeparateClass: boolean("is_separate_class").notNull().default(false),
    /** Opening written-down value carried into the current tax year. */
    openingBalance: money("opening_balance").notNull().default("0"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("tax_pools_org_book").on(t.orgId, t.bookId),
    uniqueIndex("tax_pools_identity").on(t.orgId, t.bookId, t.subsidiaryId, t.regime, t.classCode, t.isSeparateClass),
  ],
);

/** One computed tax year per pool — the annual UCC/WDV waterfall result. */
export const taxPoolPeriods = pgTable(
  "tax_pool_periods",
  {
    id: id(),
    orgId: orgRef(),
    poolId: uuid("pool_id").notNull(),
    taxYear: integer("tax_year").notNull(),
    openingBalance: money("opening_balance").notNull(),
    additions: money("additions").notNull().default("0"),
    dispositions: money("dispositions").notNull().default("0"),
    netAdditions: money("net_additions").notNull().default("0"),
    immediateExpense: money("immediate_expense").notNull().default("0"),
    base: money("base").notNull().default("0"),
    allowance: money("allowance").notNull().default("0"),
    closingBalance: money("closing_balance").notNull().default("0"),
    recapture: money("recapture").notNull().default("0"),
    terminalLoss: money("terminal_loss").notNull().default("0"),
    shortYearFactor: fxRate("short_year_factor").notNull().default("1"),
    enhancedMultiplier: fxRate("enhanced_multiplier"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("tax_pool_periods_identity").on(t.orgId, t.poolId, t.taxYear)],
);

/**
 * Org-defined tax depreciation REGIMES — the configurable counterpart to the
 * built-in engine regimes (ca_cca, uk_wda, au_pool, nz_pool). A tenant can add a
 * jurisdiction the engine doesn't ship, or shadow a built-in to override it. The
 * engine merges these over the built-ins. `classAttribute` is the asset-category
 * tax_attributes key that carries a class code for this regime (Canadian
 * data uses "ca_cca_class"; new regimes use "tax_pool_class").
 */
export const taxRegimes = pgTable(
  "tax_regimes",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(), // "ca_cca", "uk_wda", or a tenant's own
    name: text("name").notNull(),
    /** ISO country whose company/subsidiary setup makes this regime available. Null = tenant-global. */
    countryCode: text("country_code"),
    /** Pool waterfall or per-asset U.S.-style MACRS schedule calculation. */
    calculationModel: text("calculation_model", { enum: ["pool", "macrs"] }).notNull().default("pool"),
    classAttribute: text("class_attribute").notNull().default("tax_pool_class"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("tax_regimes_org_code").on(t.orgId, t.code)],
);

/**
 * Org-defined pool CLASSES (rate, method, first-year fraction, recapture/terminal
 * behavior, cost cap) per regime — makes the class table fully configurable
 * instead of code-only. The engine resolves a class from here first, then falls
 * back to the built-in regime definition.
 */
export const taxPoolClasses = pgTable(
  "tax_pool_classes",
  {
    id: id(),
    orgId: orgRef(),
    regime: text("regime").notNull(),
    classCode: text("class_code").notNull(),
    name: text("name").notNull(),
    rate: fxRate("rate").notNull(),
    method: text("method", { enum: ["declining", "straight_line"] }).notNull().default("declining"),
    firstYearFraction: fxRate("first_year_fraction").notNull().default("1"),
    allowRecapture: boolean("allow_recapture").notNull().default(true),
    allowTerminalLoss: boolean("allow_terminal_loss").notNull().default(true),
    costCap: money("cost_cap"),
    /** MACRS configuration. Null for ordinary pooled regimes. */
    depreciationSystem: text("depreciation_system", { enum: ["gds", "ads"] }),
    macrsMethod: text("macrs_method", { enum: ["200_db", "150_db", "straight_line"] }),
    recoveryPeriodYears: fxRate("recovery_period_years"),
    convention: text("convention", { enum: TAX_DEPRECIATION_CONVENTIONS }),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("tax_pool_classes_identity").on(t.orgId, t.regime, t.classCode)],
);

/**
 * Dated first-year rules per regime/class (Canada half-year rule, AII, immediate
 * expensing). LEGISLATIVELY VOLATILE, so it's config data with effective dates
 * rather than hardcoded engine logic. Org-scoped so a tenant can adjust.
 */
export const taxFirstYearRules = pgTable(
  "tax_first_year_rules",
  {
    id: id(),
    orgId: orgRef(),
    regime: text("regime").notNull(),
    /** Null = applies to every class in the regime. */
    classCode: text("class_code"),
    acquiredFrom: date("acquired_from"),
    acquiredTo: date("acquired_to"),
    /** Fraction of net additions eligible in year 1 (1 = full, 0.5 = half-year). */
    firstYearFraction: fxRate("first_year_fraction").notNull().default("1"),
    /** Enhanced first-year multiplier (Canada AII), > 1 to boost. */
    enhancedMultiplier: fxRate("enhanced_multiplier"),
    ...auditColumns,
  },
  (t) => [index("tax_first_year_rules_lookup").on(t.orgId, t.regime, t.classCode)],
);
