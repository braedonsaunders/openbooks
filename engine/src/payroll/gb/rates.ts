/**
 * GB payroll pack rate declarations: the transcribed 2026/27 HMRC tables.
 *
 * Every figure below carries the authority's own table and a quoted figure.
 * All sources returned HTTP 200 from gov.uk / legislation.gov.uk on
 * 2026-09-18 (this environment reaches gov.uk directly; no mirror, no vendor,
 * no law-firm summary, no other ERP's reading of the law anywhere in this
 * pack). Two fetches failed and are recorded so nobody re-chases them:
 * - https://www.gov.uk/guidance/check-your-payroll-calculations (my own
 *   guessed URL, HTTP 404 — the real collection lives at
 *   /government/collections/how-to-manually-check-your-payroll-calculations).
 * - The 2020/21 "National Insurance Contributions guidance for software
 *   developers" PDF on assets.publishing.service.gov.uk (HTTP gone, 36-byte
 *   body). Its method statement survives in the live sources below, so
 *   nothing is lost.
 *
 * Transcribed (engine reads these):
 * - rUK PAYE bands + the £12,570 Personal Allowance with its £100,000 taper.
 * - Class 1 NIC category-A thresholds (annual/weekly/monthly) and rates.
 * - The 2026/27 edition declaration (one published HMRC edition, 6 April).
 *
 * Declared but NOT computed (tenant-entered or refused by name):
 * - Employment Allowance (£10,500): eligibility is conditional (single-director
 *   and public-sector tests the pack cannot express), so it is a
 *   tenant-entered slot, never a computed constant.
 * - Auto-enrolment trigger + qualifying-earnings band: declared data, no
 *   engine (minimum contributions ride each employer's scheme).
 * - Student-loan / postgraduate-loan thresholds: LOCATED on the employer
 *   rates page, deliberately NOT transcribed — no slot, no engine (see
 *   jurisdictions.ts header). Class 1A/1B, statutory sick/maternity pay,
 *   the apprenticeship levy and RTI mechanics likewise: named, declared
 *   nothing.
 *
 * Region codes are ISO 3166-2:GB: ENG (England), SCT (Scotland), WLS (Wales),
 * NIR (Northern Ireland). Scotland is in `regionsWithOwnTables` because the
 * Scottish Parliament sets its own bands on non-savings income under the
 * Scotland Act 1998 — a GB year is loaded only when a published edition naming
 * SCT exists alongside the rUK tables, exactly like Quebec's TP-1015.
 */

import type { PayrollPackRates, PayrollStatutoryRateSlot } from "../statutory-rates.ts";
import type { PayrollEditionScaffold, PayrollTaxYearSupport } from "../tax-years.ts";
import { GB_2024_TAX_YEAR_START } from "./rates-2024.ts";
import { GB_2025_TAX_YEAR_START } from "./rates-2025.ts";

/** The four nations, as ISO 3166-2:GB spells them. */
export const GB_NATIONS = ["ENG", "SCT", "WLS", "NIR"] as const;

/** A GB nation code. */
export type GbNation = (typeof GB_NATIONS)[number];

/**
 * The tax year this pack transcribes, named for the year it opens: 2026/27.
 * HMRC: "The current tax year is from 6 April 2026 to 5 April 2027."
 * (https://www.gov.uk/income-tax-rates/current-rates-and-allowances) and
 * "Unless otherwise stated, the following figures apply from 6 April 2026 to
 * 5 April 2027."
 * (https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027)
 */
export const GB_TAX_YEAR = 2026;

/** First day of the 2026/27 GB tax year. */
export const GB_TAX_YEAR_START = "2026-04-06";

/** Last day of the 2026/27 GB tax year. */
export const GB_TAX_YEAR_END = "2027-04-05";

// ---------------------------------------------------------------------------
// PAYE income tax (rUK: England, Wales, Northern Ireland share these bands)
// ---------------------------------------------------------------------------

/**
 * Standard Personal Allowance 2026/27: £12,570 a year.
 * HMRC: "The standard Personal Allowance is £12,570, which is the amount of
 * income you do not have to pay tax on." (income-tax-rates) and "The standard
 * employee personal allowance for the 2026 to 2027 tax year is: ... £12,570
 * per year" (employer rates page, England and Northern Ireland AND Wales
 * sections — the two tables are identical).
 */
export const GB_PERSONAL_ALLOWANCE_ANNUAL = "12570";

/**
 * Taper: above £100,000 the allowance falls £1 for every £2 of adjusted net
 * income, reaching zero at £125,140. HMRC: "Your personal allowance goes down
 * by £1 for every £2 that your adjusted net income is above £100,000. This
 * means your allowance is zero if your income is £125,140 or above."
 * The engine does NOT taper from pay: HMRC issues the tapered code itself
 * (a reduced number, a K code), and the engine reads the code. These
 * constants document why high earners hold non-1257L codes.
 */
export const GB_TAPER_START = "100000";
export const GB_PERSONAL_ALLOWANCE_ZERO_AT = "125140";

/**
 * rUK bands in TAXABLE-pay space (pay above the Personal Allowance / code
 * free pay). Employer rates page: "Basic tax rate 20% Up to £37,700",
 * "Higher tax rate 40% From £37,701 to £125,140", "Additional tax rate 45%
 * Above £125,140" ("Annual earnings the rate applies to (above the PAYE
 * threshold)"). Tax Tables B-D 2026/27 PDF: "English and Northern Irish
 * basic rate 20% on taxable income £1 to £37,700", "higher rate 40% on
 * taxable income £37,701 to £125,140", "additional rate 45% on taxable
 * income £125,141 and above". Wales prints the identical table.
 */
export interface GbRukBand {
  /** Taxable pay the band tops out at, or null for the top band. */
  readonly upTo: string | null;
  /** Whole-percent rate, as a decimal fraction string. */
  readonly rate: string;
}

export const GB_RUK_BANDS: readonly GbRukBand[] = [
  { upTo: "37700", rate: "0.20" },
  { upTo: "125140", rate: "0.40" },
  { upTo: null, rate: "0.45" },
];

// ---------------------------------------------------------------------------
// PAYE income tax (Scotland: its own six-band starter..top structure)
// ---------------------------------------------------------------------------

/**
 * Scottish bands in TAXABLE-pay space (pay above the Personal Allowance /
 * code free pay), transcribed from the employer rates page's Scotland section
 * AND Tax Tables B-D 2026/27 PDF p.3 — the two agree to the pound.
 *
 * Employer rates page (Scotland): "Starter tax rate 19% Up to £3,967",
 * "Basic tax rate 20% From £3,968 to £16,956", "Intermediate tax rate 21%
 * From £16,957 to £31,092", "Higher tax rate 42% From £31,093 to £62,430",
 * "Advanced tax rate 45% From £62,431 to £125,140", "Top tax rate 48%
 * Above £125,140" ("Annual earnings the rate applies to (above the PAYE
 * threshold)"). Tax Tables B-D PDF p.3: "Scottish starter rate 19% on
 * taxable income £1 to £3,967", "Scottish basic rate 20% on taxable income
 * £3,968 to £16,956", "Scottish intermediate rate 21% on taxable income
 * £16,957 to £31,092", "Scottish higher rate 42% on taxable income £31,093
 * to £62,430", "Scottish advanced rate 45% on taxable income £62,431 to
 * £125,140", "Scottish top rate 48% on taxable income £125,141 and above".
 *
 * Cross-check (gross-income space) from https://www.gov.uk/scottish-income-tax
 * "Current rates" table: "Up to £12,570 0%", "£12,571 to £16,537 19%",
 * "£16,538 to £29,526 20%", "£29,527 to £43,662 21%", "£43,663 to £75,000
 * 42%", "£75,001 to £125,140 45%", "over £125,140 48%". Each top is exactly
 * £12,570 above the taxable-space top (16,537 = 12,570 + 3,967; 29,526 =
 * 12,570 + 16,956; 43,662 = 12,570 + 31,092; 75,000 = 12,570 + 62,430) —
 * the two pages agree, so no Budget papers are needed.
 *
 * The Personal Allowance is reserved (UK-wide): the Scottish page prices
 * "if you have a standard Personal Allowance of £12,570" and sends the
 * over-£125,140 rule to the UK-wide /income-tax-rates/income-over-100000
 * page ("You do not get a Personal Allowance if you earn over £125,140"),
 * and the employer page prints the same £12,570 standard allowance under
 * its Scotland heading. Scotland sets bands, not the allowance — the engine
 * reads the S-prefix code's free pay exactly as it reads 1257L's, and NIC
 * stays UK-wide (the employer NIC tables are printed once, not per nation).
 */
export interface GbSctBand {
  /** Taxable pay the band tops out at, or null for the top band. */
  readonly upTo: string | null;
  /** Whole-percent rate, as a decimal fraction string. */
  readonly rate: string;
}

export const GB_SCT_BANDS: readonly GbSctBand[] = [
  { upTo: "3967", rate: "0.19" },
  { upTo: "16956", rate: "0.20" },
  { upTo: "31092", rate: "0.21" },
  { upTo: "62430", rate: "0.42" },
  { upTo: "125140", rate: "0.45" },
  { upTo: null, rate: "0.48" },
];

// ---------------------------------------------------------------------------
// Class 1 National Insurance, category A (the standard category letter)
// ---------------------------------------------------------------------------

/**
 * Category-A thresholds 2026/27. Employer rates page: "Lower earnings limit
 * £129 per week £559 per month £6,708 per year", "Primary threshold £242 per
 * week £1,048 per month £12,570 per year", "Secondary threshold £96 per week
 * £417 per month £5,000 per year", "Upper earnings limit £967 per week
 * £4,189 per month £50,270 per year".
 */
export interface GbNicThresholds {
  readonly lel: string;
  readonly pt: string;
  readonly st: string;
  readonly uel: string;
}

export const GB_NIC_ANNUAL: GbNicThresholds = {
  lel: "6708",
  pt: "12570",
  st: "5000",
  uel: "50270",
};

export const GB_NIC_WEEKLY: GbNicThresholds = {
  lel: "129",
  pt: "242",
  st: "96",
  uel: "967",
};

export const GB_NIC_MONTHLY: GbNicThresholds = {
  lel: "559",
  pt: "1048",
  st: "417",
  uel: "4189",
};

/**
 * Employee (primary) category-A rates. Employer rates page: category letter
 * A — "0%" (LEL to PT), "8%" (above PT to UEL), "2%" (balance above UEL).
 */
export const GB_NIC_EMPLOYEE_MAIN_RATE = "0.08";
export const GB_NIC_EMPLOYEE_UPPER_RATE = "0.02";

/**
 * Employer (secondary) category-A rate. Employer rates page: category letter
 * A — "15%" on earnings above the secondary threshold (every column).
 */
export const GB_NIC_EMPLOYER_RATE = "0.15";

// ---------------------------------------------------------------------------
// Employment Allowance (tenant-entered, never computed)
// ---------------------------------------------------------------------------

/**
 * Employment Allowance 2026/27: £10,500. Employer rates page: "Employment
 * Allowance for 2026 to 2027 is £10,500." Eligibility is conditional in a way
 * the pack cannot express — "If your company has only one director, they must
 * not be the only employee liable for secondary Class 1 National Insurance"
 * and "you do less than half your work in the public sector", plus excluded
 * employee classes (https://www.gov.uk/claim-employment-allowance/eligibility)
 * — so the allowance is a tenant-entered slot, not a computed constant.
 */
export const GB_EMPLOYMENT_ALLOWANCE_ANNUAL = "10500";

const GB_EMPLOYMENT_ALLOWANCE_SLOT: PayrollStatutoryRateSlot = {
  key: "gb_employment_allowance",
  label: "Employment Allowance",
  scope: "org",
  // Decided silence: no consumer reads this slot back yet, so an unconfigured
  // allowance claims nothing and refuses nothing — refusing would stop every
  // GB run for a figure nothing prices.
  whenUnconfigured: "zero",
  // No consumer yet: no employer-aggregate levy is declared, so nothing reads
  // this back. Declared so the allowance is tenant-entered (the amount the
  // employer claims, once eligible) rather than silently absent or, worse,
  // computed as though every employer qualified.
  systemKeys: [],
  citation:
    "HMRC Employment Allowance "
    + "(https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027; "
    + "eligibility https://www.gov.uk/claim-employment-allowance/eligibility)",
  variesBecause:
    "Only eligible employers can claim, and eligibility turns on employer facts "
    + "no payroll table carries: a single-director company where the director is "
    + "the only employee liable for secondary Class 1 NICs cannot claim, more "
    + "than half the work must not be public-sector, and certain employees cannot "
    + "be included. The pack cannot test any of that, so the claimed amount is "
    + "tenant-entered.",
  fields: [
    {
      key: "amount", label: "Allowance available", kind: "amount", decimals: 2,
      min: "0", max: GB_EMPLOYMENT_ALLOWANCE_ANNUAL, required: true,
      help: "The Employment Allowance the employer claims for the year, up to "
        + "£10,500 for 2026/27. Claim only if eligible: not a single-director "
        + "company with no other secondary Class 1 liability, less than half "
        + "the work in the public sector, and no excluded employees.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Auto-enrolment band (declared data, no engine)
// ---------------------------------------------------------------------------

/**
 * Workplace-pension auto-enrolment 2026/27: trigger £10,000,
 * qualifying-earnings band £6,240–£50,270. DWP: "The Secretary of State has
 * concluded that the existing threshold of £10,000 for the earnings trigger
 * should be retained for 2026 to 2027", "the value of the LEL for 2026 to
 * 2027 will continue to be set at £6,240", "the value of the UEL for 2026 to
 * 2027 will continue to be set at £50,270."
 * (Review of the Automatic Enrolment Earnings Trigger and Qualifying Earnings
 * Band for 2026/27). Declared so the band is on the record; minimum
 * contributions ride each employer's scheme, so there is no slot and no
 * engine (see jurisdictions.ts header).
 */
export const GB_AE_TRIGGER_ANNUAL = "10000";
export const GB_AE_QUALIFYING_BAND_LOWER = "6240";
export const GB_AE_QUALIFYING_BAND_UPPER = "50270";

const GB_YEAR_MODULE_TEMPLATE = `/**
 * GB payroll pack rate declarations: the transcribed {year} HMRC tables.
 *
 * SCAFFOLD — generated by scripts/payroll-new-tax-year.ts. Every figure is
 * the UNFILLED placeholder until it is transcribed FROM THE PUBLICATION
 * (never from memory, and never by carrying a neighbour year's value over):
 *
 *   HMRC "Rates and thresholds for employers {year} to <next>"
 *     (https://www.gov.uk/guidance/rates-and-thresholds-for-employers-{year}-to-<next>;
 *     figures apply from 6 April {year} to 5 April <next>): the rUK Personal
 *     Allowance and bands (England/NI AND Wales sections), the Scotland
 *     section's starter..top bands, the emergency codes, the Class 1 NIC
 *     thresholds and category-A rates, and the Employment Allowance.
 *   HMRC P9X({year}) "Tax codes to use from 6 April {year}" (via the P9X
 *     publication page; the assets original goes 410 once superseded, so
 *     reach it through the Wayback Machine): Personal Allowance, PAYE
 *     threshold, emergency code, carry-forward rules.
 *   https://www.gov.uk/scottish-income-tax ({year} table): gross-space
 *     cross-check of the Scotland bands (each top below the taper point is
 *     exactly the Personal Allowance above the taxable-space top).
 *   https://www.gov.uk/welsh-income-tax (Rates and bands for {year}): "These
 *     rates have been set by the Welsh Government" — a table matching rUK
 *     means Wales needs no separate edition; a divergence would.
 *   DWP review of the Automatic Enrolment trigger and qualifying band for
 *     {year}: trigger and qualifying-earnings band (declared data, no engine).
 *
 * Before wiring the {year} editions, verify arithmetically, exactly as the
 * {priorYear} edition's header records: each Scottish gross-space top equals
 * its taxable-space top plus the Personal Allowance, weekly/monthly NIC
 * figures are HMRC's published roundings (never annual ÷ 52 or ÷ 12), and
 * any employer-rate or threshold change is confirmed against the neighbour
 * year's page in BOTH directions.
 */
import { UNFILLED } from "../unfilled.ts";
import type { GbNicThresholds, GbRukBand, GbSctBand } from "./rates.ts";

export const GB_{year}_TAX_YEAR_START = "{year}-04-06";

export const GB_{year}_TAX_YEAR_END = "<next>-04-05";

export const GB_{year}_MONTH_ONE_END = "{year}-05-05";

export const GB_{year}_PERSONAL_ALLOWANCE_ANNUAL = UNFILLED;

export const GB_{year}_TAPER_START = UNFILLED;
export const GB_{year}_PERSONAL_ALLOWANCE_ZERO_AT = UNFILLED;

export const GB_{year}_RUK_BANDS: readonly GbRukBand[] = [
  { upTo: UNFILLED, rate: UNFILLED },
];

export const GB_{year}_SCT_BANDS: readonly GbSctBand[] = [
  { upTo: UNFILLED, rate: UNFILLED },
];

export const GB_{year}_NIC_ANNUAL: GbNicThresholds = {
  lel: UNFILLED,
  pt: UNFILLED,
  st: UNFILLED,
  uel: UNFILLED,
};

export const GB_{year}_NIC_WEEKLY: GbNicThresholds = {
  lel: UNFILLED,
  pt: UNFILLED,
  st: UNFILLED,
  uel: UNFILLED,
};

export const GB_{year}_NIC_MONTHLY: GbNicThresholds = {
  lel: UNFILLED,
  pt: UNFILLED,
  st: UNFILLED,
  uel: UNFILLED,
};

export const GB_{year}_NIC_EMPLOYEE_MAIN_RATE = UNFILLED;
export const GB_{year}_NIC_EMPLOYEE_UPPER_RATE = UNFILLED;
export const GB_{year}_NIC_EMPLOYER_RATE = UNFILLED;
export const GB_{year}_EMPLOYMENT_ALLOWANCE_ANNUAL = UNFILLED;
export const GB_{year}_AE_TRIGGER_ANNUAL = UNFILLED;
export const GB_{year}_AE_QUALIFYING_BAND_LOWER = UNFILLED;
export const GB_{year}_AE_QUALIFYING_BAND_UPPER = UNFILLED;
`;

const GB_YEAR_TEST_TEMPLATE = `/**
 * GB {year} conformance stub.
 *
 * SCAFFOLD — generated by scripts/payroll-new-tax-year.ts, and FAILING ON
 * PURPOSE until the {year} edition is transcribed. Expand it into the full
 * parity-style suite (see rates-{priorYear}.test.ts): transcription pins for
 * every constant, hand-worked PAYE/NIC cases including the ones that
 * discriminate {year} from its neighbours, and a band-boundary sweep.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unfilledPaths } from "../unfilled.ts";
import { GB_TAX_YEARS } from "./rates.ts";
import * as yearModule from "./rates-{year}.ts";
import { gbTablesForTaxYear } from "./year-tables.ts";

test("{year} tables are transcribed, not scaffolded", () => {
  const unfilled = unfilledPaths(yearModule);
  assert.deepEqual(
    unfilled, [],
    "transcribe every {year} figure from the employer rates page — still unfilled: "
    + unfilled.join(", "),
  );
  // Both scopes publish before the year loads: the main edition AND the
  // Scotland-bands edition, each with its own citation.
  for (const region of [null, "SCT"] as const) {
    const edition = GB_TAX_YEARS.editions.find(
      (entry) => entry.year === {year} && (entry.region ?? null) === region,
    );
    assert.equal(edition?.status, "published");
    assert.equal(edition?.effectiveFrom, "{year}-04-06");
  }
  // Wired into the engine: the year resolves to tables the arithmetic reads.
  assert.equal(gbTablesForTaxYear({year}).year, {year});
});
`;

const GB_EDITION_SCAFFOLD: PayrollEditionScaffold = {
  files: [
    {
      path: "engine/src/payroll/gb/rates-{year}.ts",
      purpose: "the year's HMRC tables, every figure placeheld",
      template: GB_YEAR_MODULE_TEMPLATE,
    },
    {
      path: "engine/src/payroll/gb/rates-{year}.test.ts",
      purpose: "the failing conformance stub for the year's published goldens",
      template: GB_YEAR_TEST_TEMPLATE,
    },
  ],
  // No generated barrel: GB editions are declared literally in
  // GB_TAX_YEARS (main + SCT per year), and the year tables are wired by
  // adding one GB_{year}_TABLES entry in year-tables.ts — both named in the
  // steps below, so the rollover stays a checklist.
  barrels: [],
  steps: [
    "Fetch the year's Rates and thresholds for employers page from gov.uk "
    + "(never from memory), plus P9X, the scottish-income-tax and "
    + "welsh-income-tax tables, and the DWP auto-enrolment review.",
    "Replace every UNFILLED in engine/src/payroll/gb/rates-{year}.ts, keeping "
    + "the published figure's exact scale: Scotland bands from the Scotland "
    + "section (cross-checked to the pound against scottish-income-tax), "
    + "weekly/monthly NIC as published, never annual ÷ 52 or ÷ 12.",
    "Cross-verify arithmetically (Scottish gross-space tops, the taper-zero "
    + "identity, employer-rate changes confirmed against the neighbour "
    + "year's page in both directions).",
    "Expand rates-{year}.test.ts into the parity-style suite and paste real "
    + "published goldens, including the cases that discriminate {year} from "
    + "its neighbours.",
    "Wire GB_{year}_TABLES into engine/src/payroll/gb/year-tables.ts, add the "
    + "main AND SCT editions to GB_TAX_YEARS.editions as published, then run "
    + "the GB suite: the {year} suite must pass and the older goldens must not move.",
    "Add NIC category letters beyond A once a category-letter input channel exists.",
  ],
};

/**
 * Tax-year support: the rUK edition AND the SCT edition are transcribed for
 * 2026/27 (above), 2025/26 (rates-2025.ts) and 2024/25 (rates-2024.ts), and
 * the engine prices each year from its own tables (year-tables.ts). `regionsWithOwnTables` keeps SCT: Scotland sets its own
 * bands under the Scotland Act 1998, so a year is loaded for SCT only when a
 * published edition naming SCT exists (the Quebec TP-1015 pattern) — no
 * silent rUK fall-through. The SCT edition's bands are primary-published on
 * both the employer rates page and https://www.gov.uk/scottish-income-tax
 * (see GB_SCT_BANDS); S-prefix code routing rides it.
 */
export const GB_TAX_YEARS: PayrollTaxYearSupport = {
  country: "GB",
  editions: [
    {
      year: 2024,
      label: "Rates and thresholds for employers 2024 to 2025",
      effectiveFrom: GB_2024_TAX_YEAR_START,
      citation:
        "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2024-to-2025 "
        + "(published 6 February 2024; figures apply from 6 April 2024 to 5 April 2025) — "
        + "transcribed in engine/src/payroll/gb/rates-2024.ts",
      status: "published",
    },
    {
      year: 2024,
      region: "SCT",
      label: "Rates and thresholds for employers 2024 to 2025 (Scotland bands)",
      effectiveFrom: GB_2024_TAX_YEAR_START,
      citation:
        "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2024-to-2025 "
        + "(Scotland section), cross-checked against https://www.gov.uk/scottish-income-tax "
        + "2024 to 2025 table — transcribed in engine/src/payroll/gb/rates-2024.ts",
      status: "published",
    },
    {
      year: 2025,
      label: "Rates and thresholds for employers 2025 to 2026",
      effectiveFrom: GB_2025_TAX_YEAR_START,
      citation:
        "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026 "
        + "(published 31 January 2025; figures apply from 6 April 2025 to 5 April 2026) — "
        + "transcribed in engine/src/payroll/gb/rates-2025.ts",
      status: "published",
    },
    {
      year: 2025,
      region: "SCT",
      label: "Rates and thresholds for employers 2025 to 2026 (Scotland bands)",
      effectiveFrom: GB_2025_TAX_YEAR_START,
      citation:
        "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026 "
        + "(Scotland section), cross-checked against https://www.gov.uk/scottish-income-tax "
        + "2025 to 2026 table — transcribed in engine/src/payroll/gb/rates-2025.ts",
      status: "published",
    },
    {
      year: GB_TAX_YEAR,
      label: "Rates and thresholds for employers 2026 to 2027",
      effectiveFrom: GB_TAX_YEAR_START,
      citation:
        "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 "
        + "(published 30 January 2026, last updated 1 September 2026)",
      status: "published",
    },
    {
      year: GB_TAX_YEAR,
      region: "SCT",
      label: "Rates and thresholds for employers 2026 to 2027 (Scotland bands)",
      effectiveFrom: GB_TAX_YEAR_START,
      citation:
        "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 "
        + "(Scotland section; starter 19% to £3,967 through top 48% above £125,140), "
        + "cross-checked against https://www.gov.uk/scottish-income-tax current-rates table "
        + "and Tax Tables B-D 2026/27 PDF p.3 (see GB_SCT_BANDS)",
      status: "published",
    },
  ],
  regionsWithOwnTables: ["SCT"],
  ratesModule: "engine/src/payroll/gb/rates.ts",
  scaffold: GB_EDITION_SCAFFOLD,
};

/**
 * Tenant-entered statutory rates: the Employment Allowance only. Employer NIC
 * reliefs that are employer- and account-specific (Freeport/Investment
 * Zone/veterans upper secondary thresholds) remain undeclared until an engine
 * reads them.
 */
export const GB_PACK_RATES: PayrollPackRates = {
  country: "GB",
  slots: [GB_EMPLOYMENT_ALLOWANCE_SLOT],
};
