/**
 * US federal payroll withholding constants, versioned by tax year.
 *
 * Sources (fetched from irs.gov / ssa.gov, not memory):
 *   Pub 15-T (2026): irs.gov/publications/p15t — Annual Percentage Method
 *     Tables for Automated Payroll Systems (STANDARD and Form W-4 Step 2
 *     Checkbox schedules) and the Worksheet 1A constants.
 *   SSA (Oct 2025 announcement): 2026 OASDI wage base $184,500.
 *   FUTA: IRC §3301/§3302 — 6.0% on the first $7,000, up to 5.4% credit.
 *
 * Every printed table row was cross-verified arithmetically: each tentative
 * amount equals the cumulative tax of the prior brackets, and each STANDARD
 * threshold equals the Rev. Proc. 2025-32 bracket boundary shifted by the
 * standard deduction minus the Worksheet 1A adjustment ($12,900 MFJ /
 * $8,600 otherwise).
 */

import type {
  PayrollEditionScaffold, PayrollTaxYearSupport,
} from "../tax-years.ts";
import type {
  LegacyRateRow, PayrollPackRates, PayrollStatutoryRateSlot,
} from "../statutory-rates.ts";
import { US_EXTRA_EDITIONS } from "./editions.ts";

export type FilingStatus = "single" | "married_joint" | "head_household";

/**
 * One row of an annual percentage-method schedule: adjusted annual wages of
 * at least `atLeast` (and under the next row's `atLeast`) owe `tentative`
 * plus `rate` × the excess over `atLeast`.
 */
export interface WithholdingRow {
  atLeast: string;
  tentative: string;
  rate: string;
}

export interface FicaRates {
  ssRate: string; // 6.2% each side
  ssWageBase: string; // OASDI maximum taxable earnings
  medicareRate: string; // 1.45% each side, no cap
  additionalMedicareRate: string; // employee-only 0.9%
  additionalMedicareThreshold: string; // per-employer YTD wages trigger
}

export interface FutaRates {
  wageBase: string; // first $7,000 (statutory, unchanged since 1983)
  grossRate: string; // 6.0%
  /** Default effective rate after the full 5.4% credit; credit-reduction
   * states are handled by the org-level configurable rate. */
  defaultEffectiveRate: string;
}

export interface SupplementalRates {
  flatRate: string; // optional flat rate on supplemental wages (Pub 15 §7)
  mandatoryHighRate: string; // required over $1,000,000 YTD supplemental
  mandatoryThreshold: string;
}

export interface YearRates {
  year: number;
  /**
   * `draft` = scaffolded by scripts/payroll-new-tax-year.ts and NOT transcribed
   * yet. Required, so a new edition must state which it is; `ratesForPayDate`
   * refuses a draft rather than calculating with placeholder figures.
   */
  status: "published" | "draft";
  standard: Record<FilingStatus, WithholdingRow[]>;
  checkbox: Record<FilingStatus, WithholdingRow[]>;
  /** Worksheet 1A line 1g: subtracted unless the Step 2 box is checked. */
  wageAdjustment: { marriedJoint: string; other: string };
  /** Worksheet 1A line 1k: per-allowance amount for 2019-or-earlier W-4s. */
  allowanceAmount: string;
  fica: FicaRates;
  futa: FutaRates;
  supplemental: SupplementalRates;
}

// 2026 Annual Percentage Method Tables — STANDARD Withholding Rate Schedules.
const STANDARD_2026: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "19300", tentative: "0", rate: "0.10" },
    { atLeast: "44100", tentative: "2480", rate: "0.12" },
    { atLeast: "120100", tentative: "11600", rate: "0.22" },
    { atLeast: "230700", tentative: "35932", rate: "0.24" },
    { atLeast: "422850", tentative: "82048", rate: "0.32" },
    { atLeast: "531750", tentative: "116896", rate: "0.35" },
    { atLeast: "788000", tentative: "206583.50", rate: "0.37" },
  ],
  single: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "7500", tentative: "0", rate: "0.10" },
    { atLeast: "19900", tentative: "1240", rate: "0.12" },
    { atLeast: "57900", tentative: "5800", rate: "0.22" },
    { atLeast: "113200", tentative: "17966", rate: "0.24" },
    { atLeast: "209275", tentative: "41024", rate: "0.32" },
    { atLeast: "263725", tentative: "58448", rate: "0.35" },
    { atLeast: "648100", tentative: "192979.25", rate: "0.37" },
  ],
  head_household: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "15550", tentative: "0", rate: "0.10" },
    { atLeast: "33250", tentative: "1770", rate: "0.12" },
    { atLeast: "83000", tentative: "7740", rate: "0.22" },
    { atLeast: "121250", tentative: "16155", rate: "0.24" },
    { atLeast: "217300", tentative: "39207", rate: "0.32" },
    { atLeast: "271750", tentative: "56631", rate: "0.35" },
    { atLeast: "656150", tentative: "191171", rate: "0.37" },
  ],
};

// 2026 Form W-4, Step 2, Checkbox Withholding Rate Schedules.
const CHECKBOX_2026: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "16100", tentative: "0", rate: "0.10" },
    { atLeast: "28500", tentative: "1240", rate: "0.12" },
    { atLeast: "66500", tentative: "5800", rate: "0.22" },
    { atLeast: "121800", tentative: "17966", rate: "0.24" },
    { atLeast: "217875", tentative: "41024", rate: "0.32" },
    { atLeast: "272325", tentative: "58448", rate: "0.35" },
    { atLeast: "400450", tentative: "103291.75", rate: "0.37" },
  ],
  single: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "8050", tentative: "0", rate: "0.10" },
    { atLeast: "14250", tentative: "620", rate: "0.12" },
    { atLeast: "33250", tentative: "2900", rate: "0.22" },
    { atLeast: "60900", tentative: "8983", rate: "0.24" },
    { atLeast: "108938", tentative: "20512", rate: "0.32" },
    { atLeast: "136163", tentative: "29224", rate: "0.35" },
    { atLeast: "328350", tentative: "96489.63", rate: "0.37" },
  ],
  head_household: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "12075", tentative: "0", rate: "0.10" },
    { atLeast: "20925", tentative: "885", rate: "0.12" },
    { atLeast: "45800", tentative: "3870", rate: "0.22" },
    { atLeast: "64925", tentative: "8077.50", rate: "0.24" },
    { atLeast: "112950", tentative: "19603.50", rate: "0.32" },
    { atLeast: "140175", tentative: "28315.50", rate: "0.35" },
    { atLeast: "332375", tentative: "95585.50", rate: "0.37" },
  ],
};

export const RATES_2026: YearRates = {
  year: 2026,
  status: "published",
  standard: STANDARD_2026,
  checkbox: CHECKBOX_2026,
  wageAdjustment: { marriedJoint: "12900", other: "8600" },
  allowanceAmount: "4300",
  fica: {
    ssRate: "0.062",
    ssWageBase: "184500",
    medicareRate: "0.0145",
    additionalMedicareRate: "0.009",
    additionalMedicareThreshold: "200000",
  },
  futa: {
    wageBase: "7000",
    grossRate: "0.06",
    defaultEffectiveRate: "0.006",
  },
  supplemental: {
    flatRate: "0.22",
    mandatoryHighRate: "0.37",
    mandatoryThreshold: "1000000",
  },
};

/**
 * Every edition the pack carries: the transcribed 2026 tables plus whatever
 * year modules exist on disk (`./editions.ts` is generated from them by
 * scripts/payroll-new-tax-year.ts, so wiring a new year is writing a file
 * rather than editing a list somebody will forget).
 */
export const US_EDITIONS: readonly YearRates[] = [RATES_2026, ...US_EXTRA_EDITIONS];

const BY_YEAR: Record<number, YearRates> = Object.fromEntries(
  US_EDITIONS.map((rates) => [rates.year, rates]),
);

export function ratesForPayDate(payDate: string): YearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = BY_YEAR[year];
  if (!rates) {
    throw new Error(
      `no US federal payroll rates for ${year} — add the Pub 15-T edition to `
      + "engine/src/payroll/us/rates.ts (scripts/payroll-new-tax-year.ts scaffolds it)",
    );
  }
  // A scaffolded-but-unfilled edition is refused LOUDER than a missing one: the
  // module exists, so every "is the year loaded?" check that looked only for
  // presence would have said yes and withheld from placeholder tables.
  if (rates.status !== "published") {
    throw new Error(
      `the ${year} Pub 15-T tables are scaffolded but not transcribed — placeholder values remain `
      + "in engine/src/payroll/us/rates.ts; fill them in and flip the edition to published",
    );
  }
  return rates;
}

/** All state/territory postal codes an employee can be employed in. */
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
] as const;
export type UsState = (typeof US_STATES)[number];

/**
 * States with no wage withholding on regular earnings — the coverage of the
 * US pack's first wave. Employees in any other state fail calculation with a
 * clear per-employee error rather than producing silently-wrong stubs.
 */
export const NO_WITHHOLDING_STATES: ReadonlySet<string> = new Set([
  "AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY",
]);

// ---------------------------------------------------------------------------
// Tax-year coverage — which years the pack's tables are loaded for
// ---------------------------------------------------------------------------

/**
 * The skeleton a new Pub 15-T edition starts from. Every figure is the
 * `UNFILLED` sentinel, so the module type-checks, refuses to calculate, and
 * fails its own golden stub until a human has transcribed the publication.
 */
const US_YEAR_MODULE_TEMPLATE = `/**
 * US federal payroll withholding constants for {year}.
 *
 * SCAFFOLD — generated by scripts/payroll-new-tax-year.ts. Every value is the
 * UNFILLED placeholder until it is transcribed FROM THE PUBLICATION (never from
 * memory, and never by inflating {priorYear}):
 *
 *   Pub 15-T ({year}): irs.gov/publications/p15t — Annual Percentage Method
 *     Tables for Automated Payroll Systems (STANDARD and Form W-4 Step 2
 *     Checkbox schedules) plus the Worksheet 1A constants (lines 1g and 1k).
 *   SSA (announced each October): {year} OASDI wage base.
 *   Rev. Proc. (annual inflation adjustments): the bracket boundaries the
 *     STANDARD thresholds are derived from.
 *   FUTA: IRC 3301/3302 — unchanged unless Congress acts.
 *
 * Before flipping \`status\` to "published", verify arithmetically, exactly as
 * the {priorYear} edition's header records: each tentative amount equals the
 * cumulative tax of the prior brackets, and each STANDARD threshold equals the
 * Rev. Proc. bracket boundary shifted by the standard deduction less the
 * Worksheet 1A adjustment.
 */
import { UNFILLED } from "../unfilled.ts";
import type { FilingStatus, WithholdingRow, YearRates } from "./rates.ts";

/** One row per bracket, in ascending \`atLeast\` order. Add the rest. */
const ROWS = (): WithholdingRow[] => [
  { atLeast: "0", tentative: "0", rate: "0" },
  { atLeast: UNFILLED, tentative: UNFILLED, rate: UNFILLED },
];

const STANDARD: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: ROWS(),
  single: ROWS(),
  head_household: ROWS(),
};

const CHECKBOX: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: ROWS(),
  single: ROWS(),
  head_household: ROWS(),
};

export const RATES_{year}: YearRates = {
  year: {year},
  // Flip to "published" only when every placeholder is gone and
  // rates-{year}.test.ts passes with real published goldens.
  status: "draft",
  standard: STANDARD,
  checkbox: CHECKBOX,
  wageAdjustment: { marriedJoint: UNFILLED, other: UNFILLED },
  allowanceAmount: UNFILLED,
  fica: {
    ssRate: UNFILLED,
    ssWageBase: UNFILLED,
    medicareRate: UNFILLED,
    additionalMedicareRate: UNFILLED,
    additionalMedicareThreshold: UNFILLED,
  },
  futa: {
    wageBase: UNFILLED,
    grossRate: UNFILLED,
    defaultEffectiveRate: UNFILLED,
  },
  supplemental: {
    flatRate: UNFILLED,
    mandatoryHighRate: UNFILLED,
    mandatoryThreshold: UNFILLED,
  },
};
`;

/**
 * The conformance stub. It FAILS on generation, by design: an edition that
 * nobody has transcribed must not be able to pass a test suite, and the failure
 * message is the instruction.
 */
const US_YEAR_TEST_TEMPLATE = `/**
 * Pub 15-T {year} conformance goldens.
 *
 * SCAFFOLD — generated by scripts/payroll-new-tax-year.ts, and FAILING ON
 * PURPOSE until the {year} edition is transcribed and its published goldens are
 * pasted in below. Follow rates-{priorYear}-era practice in
 * engine/src/payroll/us/pub15t.test.ts: the goldens are worked from the
 * publication's own tables, independently of this engine's code.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../unfilled.ts";
import { calculatePub15T } from "./pub15t.ts";
import { ratesForPayDate } from "./rates.ts";
import { RATES_{year} } from "./rates-{year}.ts";

/**
 * Published goldens: annual wages, filing status, and the annual withholding
 * the {year} STANDARD schedule produces for them, taken from the publication's
 * tables. Add at least three, including one in the top bracket.
 */
const PUBLISHED: { annualWages: string; filingStatus: "single" | "married_joint" | "head_household"; annualTax: string }[] = [
  // { annualWages: "60000", filingStatus: "single", annualTax: "..." },
];

test("{year} Pub 15-T tables are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(RATES_{year});
  assert.deepEqual(
    unfilled, [],
    "transcribe every {year} figure from Pub 15-T — still unfilled: " + unfilled.join(", "),
  );
  assert.equal(
    RATES_{year}.status, "published",
    "flip RATES_{year}.status to published once every figure is transcribed",
  );
  // Published means calculable: the edition resolver must stop refusing it.
  assert.equal(ratesForPayDate("{year}-01-15").year, {year});
});

test("{year} published Pub 15-T goldens", () => {
  assert.ok(
    PUBLISHED.length >= 3,
    "paste at least three published {year} goldens from Pub 15-T before paying into {year}",
  );
  for (const golden of PUBLISHED) {
    // Annual pay period (P = 1) so the schedule is exercised directly, with no
    // annualization or rounding of a periodic amount in the way.
    const result = calculatePub15T({
      payDate: "{year}-06-15",
      periodsPerYear: 1,
      wages: golden.annualWages,
      filingStatus: golden.filingStatus,
    });
    assert.equal(
      result.fit, golden.annualTax,
      golden.filingStatus + " at " + golden.annualWages,
    );
  }
});
`;

const US_EDITION_SCAFFOLD: PayrollEditionScaffold = {
  files: [
    {
      path: "engine/src/payroll/us/rates-{year}.ts",
      purpose: "the year's Pub 15-T tables, every figure placeheld",
      template: US_YEAR_MODULE_TEMPLATE,
    },
    {
      path: "engine/src/payroll/us/rates-{year}.test.ts",
      purpose: "the failing conformance stub for the year's published goldens",
      template: US_YEAR_TEST_TEMPLATE,
    },
  ],
  barrels: [{
    path: "engine/src/payroll/us/editions.ts",
    modulePattern: "^rates-(\\d{4})\\.ts$",
    exportName: "RATES_{year}",
    template: `// GENERATED by scripts/payroll-new-tax-year.ts from the rates-<year>.ts modules
// present in this directory. Do not edit by hand — add a year by running the
// scaffold, then transcribe the published figures into the year module.
{imports}import type { YearRates } from "./rates.ts";

export const US_EXTRA_EDITIONS: readonly YearRates[] = [{entries}];
`,
  }],
  steps: [
    "Fetch Pub 15-T for the year from irs.gov (never from memory) plus the SSA "
    + "OASDI wage-base announcement and the year's Rev. Proc. bracket table.",
    "Replace every UNFILLED in engine/src/payroll/us/rates-{year}.ts, keeping the "
    + "published figure's exact scale.",
    "Cross-verify each schedule arithmetically (cumulative tentative amounts, "
    + "thresholds derived from the Rev. Proc. boundaries).",
    "Paste at least three published goldens into rates-{year}.test.ts.",
    "Flip status to \"published\", then run the payroll suite: the {year} stub "
    + "must pass and the 2026 goldens must not move.",
  ],
};

export const US_TAX_YEARS: PayrollTaxYearSupport = {
  country: "US",
  editions: US_EDITIONS.map((rates) => ({
    year: rates.year,
    label: `Pub 15-T (${rates.year})`,
    effectiveFrom: `${rates.year}-01-01`,
    citation: `IRS Publication 15-T (${rates.year}), Annual Percentage Method tables`,
    status: rates.status,
  })),
  // Federal withholding is the only income tax the pack computes; the states it
  // covers are the nine with no wage withholding at all, so no state publishes
  // tables the pack depends on.
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/us/rates.ts",
  scaffold: US_EDITION_SCAFFOLD,
};

// ---------------------------------------------------------------------------
// Tenant-entered statutory rates, and the scope each one varies by
// ---------------------------------------------------------------------------

/**
 * State unemployment insurance. The rate is EXPERIENCE-RATED and assigned by
 * the state to a specific registered account, so it is scoped to the filing
 * account — a two-EIN employer in one state holds two SUI accounts at two
 * different rates, and an employer-wide rate can only ever be right for one of
 * them. A region-wide row (no account) remains legal and is what a
 * single-account employer keeps using.
 */
const US_SUI_SLOT: PayrollStatutoryRateSlot = {
  key: "us_sui",
  label: "State unemployment (SUI) rate",
  scope: "filing_account",
  systemKeys: ["suta"],
  programType: "us_state_sui",
  citation: "State unemployment insurance law; the rate is the state's annual experience-rate notice",
  variesBecause:
    "SUI is experience-rated: the state assigns a rate to each registered employer account each "
    + "year from that account's own benefit charges, and publishes no rate a payroll system could "
    + "carry as a constant.",
  fields: [
    {
      key: "rate", label: "Rate", kind: "rate", decimals: 4,
      min: "0", max: "0.2", required: true,
      help: "As a decimal, exactly as the state's rate notice states it: 0.027 is 2.7%. "
        + "Includes any surcharge the state adds to the experience rate.",
    },
    {
      key: "wageBase", label: "Taxable wage base", kind: "amount", decimals: 2,
      min: "0", max: "10000000", required: true,
      help: "The state's taxable wage limit per employee per year. Contributions stop once an "
        + "employee's year-to-date wages under this account reach it.",
    },
  ],
};

/**
 * FUTA. The statutory 6.0% and the full 5.4% credit are pack constants; what
 * varies is the CREDIT REDUCTION, which USDOL publishes per state per year for
 * states with outstanding federal loans. Scoped per region for that reason: an
 * employer with crews in a credit-reduction state and a normal state owes two
 * different effective rates in the same payroll, and Form 940 Schedule A is
 * computed state by state.
 */
const US_FUTA_SLOT: PayrollStatutoryRateSlot = {
  key: "us_futa",
  label: "Effective FUTA rate",
  scope: "region",
  systemKeys: ["futa"],
  citation: "IRC 3301/3302; USDOL annual credit-reduction determination (Form 940 Schedule A)",
  variesBecause:
    "The 5.4% credit is reduced for states with outstanding federal unemployment loans, and USDOL "
    + "publishes the reduction per state per year — so the effective rate is a state-by-state "
    + "figure, not an employer-wide one.",
  fields: [
    {
      key: "rate", label: "Effective rate", kind: "rate", decimals: 4,
      min: "0", max: "0.2", required: true,
      help: "As a decimal: 0.006 is the standard 0.6% after the full credit. Add the state's "
        + "credit reduction for a credit-reduction state (0.009 for a 0.3% reduction).",
    },
  ],
};

export const US_PACK_RATES: PayrollPackRates = {
  country: "US",
  slots: [US_FUTA_SLOT, US_SUI_SLOT],
  /**
   * The pre-scoping shape: `orgs.settings.payroll.us` held ONE FUTA rate for the
   * whole employer and ONE SUI entry per state for every account. Reproduced
   * here exactly — the org rate standing in for every state, the state SUI entry
   * standing in for every account — so a tenant that has not touched the new
   * surface calculates byte-for-byte as it did before, and the defect is fixed
   * by entering scoped rows rather than by a migration nobody can audit.
   */
  legacyRows: (blob) => {
    const us = (blob.us ?? {}) as {
      futaRate?: unknown;
      sui?: Record<string, { rate?: unknown; wageBase?: unknown }>;
    };
    const rows: LegacyRateRow[] = [];
    if (us.futaRate != null && us.futaRate !== "") {
      for (const state of US_STATES) {
        rows.push({ slotKey: "us_futa", region: state, values: { rate: String(us.futaRate) } });
      }
    }
    for (const [state, entry] of Object.entries(us.sui ?? {})) {
      if (!entry || entry.rate == null || entry.wageBase == null) continue;
      rows.push({
        slotKey: "us_sui", region: state,
        values: { rate: String(entry.rate), wageBase: String(entry.wageBase) },
      });
    }
    return rows;
  },
};
