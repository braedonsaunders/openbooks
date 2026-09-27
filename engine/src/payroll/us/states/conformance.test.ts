/**
 * State withholding CONFORMANCE goldens, one table for every state.
 *
 * Every expected figure is TRANSCRIBED FROM AN AGENCY'S OWN WORKED EXAMPLE or
 * is that publication's own arithmetic on its own printed numbers, and each
 * row carries its citation. None was produced by running the engine and
 * pasting the answer — a test written that way proves the code does what it
 * does, which is not a conformance property.
 *
 * Where a published example CANNOT be reproduced, it is still here, marked,
 * and asserted against what the state's own TABLES produce, with the
 * discrepancy quantified in the row. Deleting an inconvenient example would
 * leave the next person to rediscover it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  payrollCertificate, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
// The PACK publishes the US declarations (its `certificates` / `withholding` /
// `reciprocity` members); importing it is what registers them.
import "../../packs.ts";
import { requireUsStateWithholding, usStateWithholdingEngines } from "./index.ts";
import type {
  UsStateWithholdingEngine, UsStateWithholdingInput, UsStateWithholdingResult,
} from "./types.ts";
import { NY_RATES_2026, NYC_WITHHOLDING, YONKERS_WITHHOLDING, yonkersNonresidentAnnualized } from "./ny.ts";
import {
  act32LocalEit, localServicesTaxPerPeriod, paUcEmployeeWithholding, PHILADELPHIA_WITHHOLDING,
  philadelphiaRateFor,
} from "./pa.ts";
import { fromUnits, roundDiv } from "../../../money/money.ts";
import {
  computeUsEmployerWithholding, computeUsWithholding, utahEmployerWaiverResult,
} from "../withholding.ts";
import { CA_RATES_2026, CA_WITHHOLDING, caAnnualizedMethod } from "./ca.ts";
import { IL_RATES_2026 } from "./il.ts";
import { DETROIT_WITHHOLDING, MI_RATES_2026, MI_TAXING_CITIES, miCityWithholding } from "./mi.ts";
import { D, divIntCents, mulRateCents, U } from "../../canada/decimal.ts";
import { GA_EDITIONS, gaEditionForPayDate } from "./ga.ts";
import { MA_RATES_2026, maSupplementalWithholding } from "./ma.ts";
import { NC_RATES_2026, ncAnnualizedMethod, ncSupplementalFlat } from "./nc.ts";
import { NJ_RATES_2026 } from "./nj.ts";
import {
  OH_EDITIONS, OH_SCHOOL_DISTRICTS_2026, ohMunicipalWithholding, ohOptionalComputerFormula,
  ohPercentageMethod, ohSchoolDistrict, ohSchoolDistrictWithholding,
} from "./oh.ts";
import { pctToRate } from "./transcription.ts";
import { certificateAnswersProblem } from "../../certificates.ts";
import { RATES_2026 } from "../rates.ts";
import {
  AL_WITHHOLDING, alAnnualTax, alDependentAllowance, alPersonalExemption, alStandardDeduction,
  alSupplementalFlat,
} from "./al.ts";
import { AR_RATES_2026, arAnnualGrossTax, arMidrangeLookup, arRoundToDollar } from "./ar.ts";
import { AZ_CERTIFICATE, AZ_WITHHOLDING, azRateForPrintedPercent } from "./az.ts";
import { coFamliWithholding } from "./co.ts";
import {
  ctInitialTax, ctPaidLeaveWithholding, ctPersonalCredit, ctPersonalExemption, ctPhaseOutAddBack,
  ctTaxRecapture,
} from "./ct.ts";
import {
  DC_RATES_2026, dcAllowancePerPeriod, dcDivisorForPeriod, dcScaledBrackets, type DcYearRates,
} from "./dc.ts";
import { DE_RATES_2026, deAnnualPeriods, deAnnualTax } from "./de.ts";
import { HI_CERTIFICATE } from "./hi.ts";
import { IN_COUNTIES_2026, inApplicableCounty, inCounty, inPeriodTaxable } from "./in.ts";
import {
  addPrintedPercents, MD_COUNTIES_2026, MD_MW507_NR, MD_RECIPROCITY_AGREEMENTS, mdAnneArundelLocal,
  mdAnnualCombinedTax, mdCombinedRate, mdCounty, mdDelawareResidentTax, mdLumpSumBonus,
  mdScheduleFor,
} from "./md.ts";
import { ME_RATES_2026, meStandardDeduction } from "./me.ts";
import { ND_NDWM_CERTIFICATE, ND_TRIBAL_CERTIFICATE, ND_WAGE_EXCLUSION_CERTIFICATE } from "./nd.ts";
import { OK_OW9MSE_CERTIFICATE, OK_SERVICE_CLASS_CERTIFICATE } from "./ok.ts";
import { MN_RATES_2026, mnSupplementalFlat } from "./mn.ts";
import { NM_RATES_2026, nmSupplementalFlat } from "./nm.ts";
import {
  OR_RATES_2026, OR_REGION, orAnnualWithholding, orMulRateDollars, orRoundToDollar,
  orSupplementalFlat, orTransitWithholding,
} from "./or.ts";
import { SC_RATES_2026, scAnnualTax, scStandardDeduction } from "./sc.ts";
import { vaSupplementalFlat } from "./va.ts";
import { WI_RATES_2026, wiAnnualTax, wiDeduction } from "./wi.ts";
import { wvRoundToDollar } from "./wv.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

/** Engine input without the certificate, which a row states as answers. */
type RowInput = Partial<Omit<UsStateWithholdingInput, "certificate">>
  & Pick<UsStateWithholdingInput, "payDate" | "periodsPerYear" | "wages">;

interface Golden {
  /** Postal code; the engine is the state's registered one unless `engine` names a local levy. */
  state: string;
  year: number;
  /** The publication's own label for the example, or what the row pins. */
  label: string;
  citation: string;
  engine?: UsStateWithholdingEngine;
  /** Certificate read, when it is not the engine's own (local levies, PA REV-419). */
  certificateKey?: string;
  /** Stored certificate answers; `null` means no certificate on file. Defaults to `{}`. */
  answers?: Record<string, string> | null;
  /** `basis` defaults to resident. */
  input: RowInput;
  /** Trace lines, as printed amounts ("23054" → 23054.0000). */
  expectedFactors?: Record<string, string>;
  expectedTax: string;
  /** Other result members, as printed amounts. */
  expectedResult?: Partial<Record<"taxSupplemental" | "statutoryTax" | "additionalWithholding", string>>;
}

interface Refusal {
  state: string;
  label: string;
  engine?: UsStateWithholdingEngine;
  certificateKey?: string;
  answers?: Record<string, string> | null;
  input: RowInput;
  /** The refusal must name its cause and its remedy. */
  refusal: RegExp;
}

function engineFor(row: { state: string; engine?: UsStateWithholdingEngine }): UsStateWithholdingEngine {
  const engine = row.engine ?? requireUsStateWithholding(row.state);
  assert.ok(engine, `${row.state} has no withholding engine`);
  return engine;
}

function certificateFor(
  engine: UsStateWithholdingEngine,
  row: { certificateKey?: string; answers?: Record<string, string> | null },
): ResolvedCertificate {
  const key = row.certificateKey ?? engine.certificateKey;
  assert.ok(key, `${engine.state} reads no certificate; name one with certificateKey`);
  const certificate = payrollCertificate("US", key);
  return row.answers === null
    ? resolveCertificate({ certificate })
    : resolvedCertificate(certificate, row.answers ?? {});
}

/** What a row states about the case; extra tests build one the same way. */
type Case = Pick<Golden, "state" | "engine" | "certificateKey" | "answers" | "input">;

function compute(row: Case): UsStateWithholdingResult {
  const engine = engineFor(row);
  return engine.compute({ basis: "resident", ...row.input, certificate: certificateFor(engine, row) });
}

const GOLDENS: Golden[] = [
  // CA — EDD 2026 California Withholding Schedules (DE 44), Method B
  {
    state: "CA", year: 2026, label: "Example A — weekly $210, single, 1 allowance: low income exemption",
    citation: "EDD 2026 Withholding Schedules, Method B, Example A",
    // Earnings are below the Table 1 weekly low income exemption ($363), so nothing is withheld.
    answers: { filing_status: "single_or_dual", regular_allowances: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "210.00" },
    expectedFactors: { CA_LOW_INCOME: "363" },
    expectedTax: "0",
  },
  {
    state: "CA", year: 2026, label: "Example B — biweekly $1,600, married, 3 allowances (1 estimated): $2.38",
    citation: "EDD 2026 Withholding Schedules, Method B, Example B",
    // Table 2 is read at n=1 ($38) and the Table 4 credit at n=2 ($12.95); reading Table 4 at n=3
    // would give $0.00. Table 27: 2.2% × ($1,123 − $852) = $5.96, plus $9.37 = $15.33.
    answers: { filing_status: "married_one_income", regular_allowances: "2", estimated_deduction_allowances: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "1600.00" },
    expectedFactors: {
      CA_LOW_INCOME: "1454", CA_EST_DEDUCTION: "38", CA_SUBJECT: "1562", CA_STD_DEDUCTION: "439",
      CA_TAXABLE: "1123", CA_COMPUTED_TAX: "15.33", CA_CREDIT: "12.95",
    },
    expectedTax: "2.38",
  },
  {
    state: "CA", year: 2026, label: "no DE 4 on file carries a pre-2020 federal W-4 (married, 2 allowances)",
    citation: "EDD Rates and Withholding, https://edd.ca.gov/en/Payroll_Taxes/Rates_and_Withholding",
    // Must equal the DE 4 married/2 row below: the legacy W-4 is continued, not re-read.
    answers: null,
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "1600.00", federalLegacyW4: { status: "married", allowances: 2 } },
    expectedFactors: { CA_LEGACY_W4: "0.0001" },
    expectedTax: "3.22",
  },
  {
    state: "CA", year: 2026, label: "DE 4 married, 2 allowances — the legacy W-4 equivalent",
    citation: "EDD 2026 Withholding Schedules, Method B",
    answers: { filing_status: "married_one_income", regular_allowances: "2" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "1600.00" },
    expectedTax: "3.22",
  },
  {
    state: "CA", year: 2026, label: "military-spouse DE 4 line 4 with all three statutory attestations is exempt",
    citation: "EDD DE 4, line 4 military spouse exemption",
    answers: {
      military_spouse_exempt: "true", servicemember_is_armed_forces_member: "true",
      spouse_present_solely_to_accompany: "true", spouse_domiciled_outside_ca: "true",
    },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "1600.00" },
    expectedFactors: { CA_EXEMPT: "0.0001" },
    expectedTax: "0",
  },
  {
    state: "CA", year: 2026, label: "Example C — monthly $5,100, married, 5 allowances: $0.82",
    citation: "EDD 2026 Withholding Schedules, Method B, Example C",
    // Taxable 5,100 − 951; computed tax 50.62 + 20.33.
    answers: { filing_status: "married_one_income", regular_allowances: "5" },
    input: { payDate: "2026-03-31", periodsPerYear: 12, wages: "5100.00" },
    expectedFactors: { CA_TAXABLE: "4149", CA_COMPUTED_TAX: "70.95", CA_CREDIT: "70.13" },
    expectedTax: "0.82",
  },
  {
    state: "CA", year: 2026, label: "Example D — weekly $950, head of household, 3 allowances: $1.69",
    citation: "EDD 2026 Withholding Schedules, Method B, Example D",
    // Taxable 950 − 219; computed tax 6.71 + 4.69.
    answers: { filing_status: "head_household", regular_allowances: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "950.00" },
    expectedFactors: { CA_TAXABLE: "731", CA_COMPUTED_TAX: "11.40" },
    expectedTax: "1.69",
  },

  // IL — Booklet IL-700-T (R-12/25), automated payroll method
  {
    state: "IL", year: 2026, label: "Example B — weekly $800, 2 basic + 2 additional allowances: $32.13",
    citation: "Illinois Booklet IL-700-T (R-12/25), automated payroll method, Example B",
    // 2 × $2,925 + 2 × $1,000 = $7,850; ÷ 52 = $150.96, rounded BEFORE subtracting as the booklet
    // prints it (full precision gives $649.0385); $649.04 × .0495 = $32.13.
    answers: { line1_allowances: "2", line2_allowances: "2" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedFactors: { IL_ANNUAL_EXEMPTION: "7850", IL_PERIOD_EXEMPTION: "150.96", IL_TAXABLE: "649.04" },
    expectedTax: "32.13",
  },
  {
    state: "IL", year: 2026, label: "Line 3 additional is added AFTER the rate, not taxed: $57.13",
    citation: "Illinois Booklet IL-700-T (R-12/25), Example B with IL-W-4 Line 3 $25.00",
    answers: { line1_allowances: "2", line2_allowances: "2", additional_per_period: "25.00" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedTax: "57.13",
  },
  {
    state: "IL", year: 2026, label: "no IL-W-4 on file withholds on the entire compensation: $39.60",
    citation: "Form IL-W-4 instructions: without a completed IL-W-4, withhold without allowing any exemptions",
    answers: null,
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedFactors: { IL_ANNUAL_EXEMPTION: "0" },
    expectedTax: "39.60",
  },
  {
    state: "IL", year: 2026, label: "IL-W-4 total exemption is disregarded without a total-exemption federal W-4",
    citation: "Illinois Publication 130 (R-02/26), pp. 7–8",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", federalWithholdingExempt: false },
    expectedFactors: { IL_ANNUAL_EXEMPTION: "0" },
    expectedTax: "39.60",
  },
  {
    state: "IL", year: 2026, label: "total exemption honored when both IL-W-4 and federal W-4 claim it",
    citation: "Illinois Publication 130 (R-02/26), pp. 7–8",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", federalWithholdingExempt: true },
    expectedTax: "0",
  },

  // NY — NYS-50-T-NYS (1/26), Method II
  {
    state: "NY", year: 2026, label: "Single Example 1 — weekly $400, 3 exemptions: $8.01",
    citation: "NYS-50-T-NYS (1/26), Method II, Single Example 1",
    // 36.95 × .0440 = 1.63, + 6.38.
    answers: { filing_status: "single_or_hoh", nys_allowances: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "400.00" },
    expectedFactors: { NYS_ALLOWANCE: "200.05", NYS_NET: "199.95" },
    expectedTax: "8.01",
  },
  {
    state: "NY", year: 2026, label: "Single Example 2 — semimonthly $5,000, 1 exemption: $258.50, one cent below the printed $258.51",
    citation: "NYS-50-T-NYS (1/26) p. 16, Method II, Single Example 2",
    // The pub prints $165.00 × 0.0753 = $12.43; the exact 12.4245 rounds half-up to $12.42. It truncates in
    // the married twin, so no one rule reproduces both; half-up matches 21 of the 24 printed examples.
    answers: { filing_status: "single_or_hoh", nys_allowances: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 24, wages: "5000.00" },
    expectedFactors: { NYS_NET: "4650" },
    expectedTax: "258.50",
  },
  {
    state: "NY", year: 2026, label: "Single Example 3 — monthly $50,000, 3 exemptions: $3,576.63",
    citation: "NYS-50-T-NYS (1/26), Method II, Single Example 3",
    // 1,985.71 + 1,590.92.
    answers: { filing_status: "single_or_hoh", nys_allowances: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "50000.00" },
    expectedFactors: { NYS_NET: "49133.40" },
    expectedTax: "3576.63",
  },
  {
    state: "NY", year: 2026, label: "Single Example 4 — daily $750, 2 exemptions: $44.10",
    citation: "NYS-50-T-NYS (1/26), Method II, Single Example 4",
    answers: { filing_status: "single_or_hoh", nys_allowances: "2" },
    input: { payDate: "2026-03-06", periodsPerYear: 260, wages: "750.00" },
    expectedFactors: { NYS_NET: "713.85" },
    expectedTax: "44.10",
  },
  {
    state: "NY", year: 2026, label: "Married Example 1 — weekly $400, 4 exemptions: $6.69",
    citation: "NYS-50-T-NYS (1/26), Method II, Married Example 1",
    answers: { filing_status: "married", nys_allowances: "4" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "400.00" },
    expectedFactors: { NYS_ALLOWANCE: "229.90" },
    expectedTax: "6.69",
  },
  {
    state: "NY", year: 2026, label: "Married Example 3 — monthly $50,000, 3 exemptions: $3,622.09",
    citation: "NYS-50-T-NYS (1/26), Method II, Married Example 3",
    answers: { filing_status: "married", nys_allowances: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "50000.00" },
    expectedFactors: { NYS_NET: "49087.60" },
    expectedTax: "3622.09",
  },
  {
    state: "NY", year: 2026, label: "Married Example 4 — daily $750, 2 exemptions: $44.58",
    citation: "NYS-50-T-NYS (1/26), Method II, Married Example 4",
    // Step 4 prints the rate as "0.0811", but the table says 0.0801 and only 0.0801 reproduces the
    // printed $8.47 (8.47 + 36.11); the example's rate is a typo.
    answers: { filing_status: "married", nys_allowances: "2" },
    input: { payDate: "2026-03-06", periodsPerYear: 260, wages: "750.00" },
    expectedTax: "44.58",
  },
  {
    state: "NY", year: 2026, label: "Method III replaces Method II above the annualized threshold",
    citation: "NYS-50-T-NYS (1/26), Method III (no printed worked example)",
    // net 120,000 − 616.70 = 119,383.30; annualized 1,432,599.60 ≥ 1,077,550; × .1045 = 149,706.66;
    // ÷ 12 = 12,475.56. The pub prints no Method III example, so both roundings follow the engines'
    // half-up-to-the-cent convention rather than a citation.
    answers: { filing_status: "single_or_hoh", nys_allowances: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "120000.00" },
    expectedFactors: { NYS_METHOD3_RATE: "0.1045", NYS_ANNUALIZED_NET: "1432599.60" },
    expectedTax: "12475.56",
  },
  {
    state: "NY", year: 2026, label: "nonresident prices the IT-2104.1 40% service share: $10.76, not $43.17",
    citation: "NYS-50 Part K, IT-2104.1 allocation",
    answers: { filing_status: "single_or_hoh", nys_allowances: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      supportingCertificates: {
        us_ny_it2104_1: resolvedCertificate(payrollCertificate("US", "us_ny_it2104_1"), { nys_service_percent: "40" }),
      },
    },
    expectedTax: "10.76",
  },

  // NY-NYC — NYS-50-T-NYC (1/26)
  ...([
    ["Single", "single_or_hoh", 1, 52, "400.00", "3", "6.11"],
    ["Single", "single_or_hoh", 2, 24, "5000.00", "1", "188.80"],
    ["Single", "single_or_hoh", 3, 12, "50000.00", "3", "2070.50"],
    ["Single", "single_or_hoh", 4, 260, "750.00", "2", "29.51"],
    ["Married", "married", 1, 52, "400.00", "4", "5.17"],
    ["Married", "married", 2, 24, "5000.00", "3", "184.37"],
    ["Married", "married", 3, 12, "50000.00", "3", "2068.73"],
    ["Married", "married", 4, 260, "750.00", "2", "29.43"],
  ] as const).map(([table, status, n, periodsPerYear, wages, allowances, tax]): Golden => ({
    state: "NY-NYC", year: 2026, label: `${table} Example ${n} — ${periodsPerYear} periods, $${wages}, allowances ${allowances}: $${tax}`,
    citation: `NYS-50-T-NYC (1/26), ${table} Example ${n}`, engine: NYC_WITHHOLDING, certificateKey: "us_ny_it2104",
    answers: { filing_status: status, nyc_allowances: allowances },
    input: { payDate: "2026-03-06", periodsPerYear, wages },
    expectedTax: tax,
  })),

  // NY-YONKERS — NYS-50-T-Y (1/26); resident is 16.75% of the NYS tax, which the caller passes in
  ...([
    ["Single Example 1", 52, "8.01", "1.34"],
    ["Single Example 4", 260, "44.10", "7.39"],
    ["Married Example 1", 52, "6.69", "1.12"],
    ["Married Example 3", 12, "3622.09", "606.70"],
    ["Married Example 4", 260, "44.58", "7.47"],
  ] as const).map(([example, periodsPerYear, nysTax, tax]): Golden => ({
    state: "NY-YONKERS", year: 2026, label: `resident ${example} — 16.75% of $${nysTax} NYS tax: $${tax}`,
    citation: `NYS-50-T-Y (1/26), resident ${example}`, engine: YONKERS_WITHHOLDING, certificateKey: "us_ny_it2104",
    input: { payDate: "2026-03-06", periodsPerYear, wages: "0", regionTax: nysTax },
    expectedTax: tax,
  })),
  {
    state: "NY-YONKERS", year: 2026, label: "resident Single Example 3 — $599.09, where the publication truncated to $599.08",
    citation: "NYS-50-T-Y (1/26), resident Single Example 3",
    // $3,576.63 × 0.1675 = 599.085525; half-up gives $599.09, and seven of the eight Yonkers examples
    // match half-up exactly.
    engine: YONKERS_WITHHOLDING, certificateKey: "us_ny_it2104",
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "0", regionTax: "3576.63" },
    expectedTax: "599.09",
  },
  {
    state: "NY-YONKERS", year: 2026, label: "resident surcharge excludes the IT-2104 state additional: $7.39, not $10.74",
    citation: "NYS-50-T-Y (1/26) Method VII Steps 2–5; 20 NYCRR 251.1",
    // Single Example 4's $44.10 table tax plus a $20.00 additional arrives as $64.10; the surcharge base
    // is the $44.10, so this must equal the Single Example 4 row.
    engine: YONKERS_WITHHOLDING, certificateKey: "us_ny_it2104",
    answers: { nys_additional: "20.00" },
    input: { payDate: "2026-03-06", periodsPerYear: 260, wages: "0", regionTax: "64.10" },
    expectedFactors: { YONKERS_BASE: "44.10" },
    expectedTax: "7.39",
  },
  ...([
    // Example 1 falls on line 1; Example 2 is ($200 − $38) × 0.0050; Example 3 is ($400 − $125) × 0.0050.
    [1, 52, "75.00", "0"],
    [2, 52, "200.00", "0.81"],
    [3, 24, "400.00", "1.38"],
  ] as const).map(([n, periodsPerYear, wages, tax]): Golden => ({
    state: "NY-YONKERS", year: 2026, label: `nonresident Method VII Example ${n} — $${wages}: $${tax}`,
    citation: `NYS-50-T-Y (1/26), nonresident Method VII, Example ${n}`,
    engine: YONKERS_WITHHOLDING, certificateKey: "us_ny_it2104",
    input: { payDate: "2026-03-06", periodsPerYear, wages, basis: "nonresident" },
    expectedTax: tax,
  })),

  // PA — Pennsylvania DOR, REV-415 employer withholding (flat 3.07%, no allowances)
  {
    state: "PA", year: 2026, label: "flat 3.07% on all compensation, no allowances: $61.40",
    citation: "PA DOR REV-415, personal income tax withholding at 3.07%",
    certificateKey: "us_pa_rev419",
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2000.00" },
    expectedTax: "61.40",
  },
  {
    state: "PA", year: 2026, label: "supplemental compensation is ADDED and taxed at the same rate: $214.90",
    citation: "PA DOR REV-415: add the supplemental compensation and multiply by the withholding rate",
    certificateKey: "us_pa_rev419",
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2000.00", supplemental: "5000.00" },
    expectedFactors: { PA_COMPENSATION: "7000" },
    expectedTax: "214.90",
  },

  // PA-PHILA — Philadelphia wage tax, phila.gov (rate keyed to the pay date, changes 1 July)
  ...([
    ["resident", "2026-08-14", "74.70", "3.735%"],
    ["nonresident", "2026-08-14", "68.50", "3.425%"],
    ["resident", "2026-03-06", "74.80", "3.74%"],
    ["nonresident", "2026-03-06", "68.60", "3.43%"],
  ] as const).map(([basis, payDate, tax, rate]): Golden => ({
    state: "PA-PHILA", year: 2026, label: `${basis} wage tax paid ${payDate} — $2,000 × ${rate}: $${tax}`,
    citation: "City of Philadelphia wage tax rates, phila.gov", engine: PHILADELPHIA_WITHHOLDING, certificateKey: "us_pa_clgs32_6",
    input: {
      payDate, periodsPerYear: 26, wages: "2000.00", basis,
      ...(basis === "nonresident"
        ? { wageAllocations: [{ region: "PA", subRegion: "PHILADELPHIA", workShare: "1", source: "adequate_records" as const }] }
        : {}),
    },
    expectedTax: tax,
  })),
  {
    state: "PA-PHILA", year: 2026, label: "nonresident is taxed only on verified city-source wages — 40% of $2,000 × 3.425%: $27.40",
    citation: "City of Philadelphia wage tax, nonresident work performed in the City, phila.gov",
    engine: PHILADELPHIA_WITHHOLDING, certificateKey: "us_pa_clgs32_6",
    input: {
      payDate: "2026-08-14", periodsPerYear: 26, wages: "2000.00", basis: "nonresident",
      wageAllocations: [{ region: "PA", subRegion: "PHILADELPHIA", workShare: "0.4", source: "adequate_records" }],
    },
    expectedTax: "27.40",
  },
  // NEW JERSEY — NJ-WT (September 2025) p. 25, percentage-method examples
  {
    state: "NJ", year: 2026, label: "Rate A Example 1 — weekly $300, single, 1 allowance: $4.21",
    citation: "NJ-WT (September 2025) p. 25, Rate A Example 1",
    // $300 − 19.20 = 280.80, in the $0–$384 line at 1.5%.
    answers: { filing_status: "single", allowances: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "300.00" },
    expectedFactors: { NJ_EXEMPTION: "19.20", NJ_TAXABLE: "280.80" },
    expectedTax: "4.21",
  },
  {
    state: "NJ", year: 2026, label: "Rate A Example 2 — weekly $700, single, 1 allowance: $11.84",
    citation: "NJ-WT (September 2025) p. 25, Rate A Example 2",
    // "between $673 and $769 — $11.54 plus 3.9% of amount over $673": 11.54 + .30.
    answers: { filing_status: "single", allowances: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "700.00" },
    expectedFactors: { NJ_TAXABLE: "680.80" },
    expectedTax: "11.84",
  },
  {
    state: "NJ", year: 2026, label: "Rate B Example 1 — weekly $375, joint, 3 allowances: $4.76",
    citation: "NJ-WT (September 2025) p. 25, Rate B Example 1",
    answers: { filing_status: "married_joint", allowances: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "375.00" },
    expectedFactors: { NJ_EXEMPTION: "57.60", NJ_TAXABLE: "317.40" },
    expectedTax: "4.76",
  },
  // NJ-WT's Rate A example 3 and Rate B examples 2 and 3 were computed against
  // SUPERSEDED brackets ($15.28 / $384 / $5.76 / $961 / $17.30 where the current
  // tables print $15.29 / $385 / $5.77 / $962 / $17.31). The engine uses the
  // tables the instructions direct an employer to; the printed figure is kept in
  // the label so the cent of difference stays visible.
  {
    state: "NJ", year: 2026, label: "Rate A Example 3 — weekly $1,200 (printed $40.40 on superseded brackets): $40.41",
    citation: "NJ-WT (September 2025) p. 25, Rate A Example 3, against the current Rate A weekly table",
    answers: { filing_status: "single", allowances: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1200.00" },
    expectedFactors: { NJ_TAXABLE: "1180.80" },
    expectedTax: "40.41",
  },
  {
    state: "NJ", year: 2026, label: "Rate B Example 2 — weekly $950 (printed $15.93 on superseded brackets): $15.92",
    citation: "NJ-WT (September 2025) p. 25, Rate B Example 2, against the current Rate B weekly table",
    answers: { filing_status: "married_joint", allowances: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "950.00" },
    expectedFactors: { NJ_TAXABLE: "892.40" },
    expectedTax: "15.92",
  },
  {
    state: "NJ", year: 2026, label: "Rate B Example 3 — weekly $1,400 (printed $27.60 on superseded brackets): $27.58",
    citation: "NJ-WT (September 2025) p. 25, Rate B Example 3, against the current Rate B weekly table",
    answers: { filing_status: "married_joint", allowances: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1400.00" },
    expectedFactors: { NJ_TAXABLE: "1342.40" },
    expectedTax: "27.58",
  },
  {
    state: "NJ", year: 2026, label: "NJ-W4 line 6 exempt stops withholding",
    citation: "Form NJ-W4 line 6",
    answers: { filing_status: "single", exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1400.00" },
    expectedTax: "0",
  },

  // MICHIGAN — Detroit Form 5469 (Rev. 05-25); Form 446 (Rev. 02-26)
  {
    state: "MI", year: 2026, engine: DETROIT_WITHHOLDING,
    label: "Detroit worked example — weekly $200, resident, 3 exemptions: $3.97",
    citation: "Detroit Form 5469 (Rev. 05-25), worked example",
    // "$165.38 ($200.00 - $34.62) … 2.4% resident rate ($165.38 x 0.024) … withhold $3.97"
    answers: { exemptions: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "200.00" },
    expectedFactors: { DETROIT_TAXABLE: "165.38" },
    expectedTax: "3.97",
  },
  {
    state: "MI", year: 2026, engine: DETROIT_WITHHOLDING,
    label: "Detroit nonresident rate is exactly half the resident rate: $1.98",
    citation: "Detroit Form 5469 (Rev. 05-25), 1.2% nonresident rate on the worked example's facts",
    answers: { exemptions: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "200.00", basis: "nonresident" },
    expectedTax: "1.98", // 165.38 × 1.2%
  },
  {
    state: "MI", year: 2026, engine: DETROIT_WITHHOLDING,
    label: "Detroit bonus is taxed in full, without exemptions: $1,000 at 2.4% = $24.00",
    citation: "Detroit Form 5469 (Rev. 05-25): \"For bonuses … do not adjust for exemptions\"",
    answers: { exemptions: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "200.00", supplemental: "1000.00" },
    expectedResult: { taxSupplemental: "24.00" },
    expectedTax: "27.97",
  },
  {
    // NOT CONFORMANCE, and labelled so: Form 446 prints the rate and the
    // exemption and no worked example. What is evidenced is Detroit's printed
    // per-period convention (annual ÷ periods, to the cent) applied to $5,900.
    state: "MI", year: 2026,
    label: "Form 446 masthead figures (no published example) — weekly $1,000, 2 exemptions: $32.86",
    citation: "Michigan Form 446 (Rev. 02-26) masthead: 4.25%, $5,900 exemption",
    // $5,900 ÷ 52 = $113.4615 → $113.46 each; 1,000 − 226.92 = 773.08 × 4.25% = 32.8559.
    answers: { exemptions: "2" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { MI_EXEMPTION_PER_PERIOD: "113.46", MI_TAXABLE: "773.08" },
    expectedTax: "32.86",
  },

  // MASSACHUSETTS — Circular M (Rev. 12/25)
  {
    state: "MA", year: 2026,
    label: "percentage method — weekly $1,115, 1 exemption, $38.46 retirement: $49.58 (bracket table prints $49.60)",
    citation: "Circular M (Rev. 12/25) p. 12 percentage method; weekly wage-bracket line \"1,110 but less than 1,120\"",
    // The bracket table taxes the band midpoint with exact annual factors ÷ 52;
    // the percentage method uses the rounded per-period $85, so it lands two
    // cents away. Both are published; the engine implements the percentage method.
    answers: { total_exemptions: "1" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1115.00",
      socialInsuranceDeducted: { period: "38.46", yearToDate: "0" },
    },
    expectedFactors: { MA_EXEMPTION_FACTOR: "85" },
    expectedTax: "49.58",
  },
  {
    state: "MA", year: 2026, label: "4% surtax is annualized — weekly $25,000, 0 exemptions: $1,397.88",
    citation: "Circular M (Rev. 12/25), 9% over $1,107,750 annualized",
    // 1,300,000 − 1,107,750 = 192,250 × 9% = 17,302.50; + 1,107,750 × 5% = 55,387.50.
    answers: { total_exemptions: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "25000.00" },
    expectedFactors: { MA_ANNUAL_TAX: "72690" },
    expectedTax: "1397.88",
  },
  {
    state: "MA", year: 2026, label: "zero exemptions deducts nothing, not the $66 base — weekly $2,000: $100",
    citation: "Circular M (Rev. 12/25) exemption factors; 5% below the surtax threshold",
    answers: { total_exemptions: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "2000.00" },
    expectedFactors: { MA_EXEMPTION_FACTOR: "0" },
    expectedTax: "100",
  },
  {
    state: "MA", year: 2026, label: "below the $154 weekly floor with an exemption: nothing withheld",
    citation: "Circular M (Rev. 12/25): \"Do not withhold … if their wages are less than: weekly $154\"",
    answers: { total_exemptions: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "150.00" },
    expectedFactors: { MA_BELOW_WITHHOLDING_FLOOR: "154" },
    expectedTax: "0",
  },
  {
    state: "MA", year: 2026, label: "the wage floor applies only when an exemption is claimed — weekly $150, 0 exemptions: $7.50",
    citation: "Circular M (Rev. 12/25) wage floor, \"employees who claim one or more exemptions\"",
    answers: { total_exemptions: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "150.00" },
    expectedTax: "7.50",
  },
  {
    state: "MA", year: 2026, label: "M-4 student exemption withholds nothing",
    citation: "Form M-4 full-time student exemption",
    answers: { total_exemptions: "1", student_exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "500.00" },
    expectedTax: "0",
  },
  {
    state: "MA", year: 2026, label: "a fully supported M-4-MS claim stops withholding",
    citation: "Form M-4-MS and mass.gov military spouse guidance",
    answers: { total_exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      supportingCertificates: {
        us_ma_m4_ms: resolvedCertificate(payrollCertificate("US", "us_ma_m4_ms"), {
          claim_status: "elect_servicemember_residence", active_duty_servicemember_spouse: "true",
          servicemember_orders_assign_ma: "true", spouse_present_to_accompany: "true",
          same_non_ma_domicile: "true", military_spouse_id_on_file: "true", dd2058_on_file: "true",
          servicemember_les_on_file: "true", current_military_orders_on_file: "true",
        }),
      },
    },
    expectedTax: "0",
  },

  // GEORGIA — Employer's Withholding Tax Guide 2026 (December 2025 and June 2026 revisions)
  {
    state: "GA", year: 2026, label: "June 2026 Example #1 — semi-monthly $2,000, married one income, 1 dependent: $27.03",
    citation: "Georgia Employer's Withholding Tax Guide (June 2026), Example #1",
    // $2,000 − $1,250 (Table E(1)) − $208.33 = 541.67 × 0.0499.
    answers: { marital_status: "C", dependent_allowances: "1" },
    input: { payDate: "2026-06-15", periodsPerYear: 24, wages: "2000.00" },
    expectedFactors: { GA_RATE: "0.0499", GA_TAXABLE: "541.67" },
    expectedTax: "27.03",
  },
  {
    state: "GA", year: 2026, label: "June 2026 Example #2 — head of household biweekly $935, 2 dependents: $0.00",
    citation: "Georgia Employer's Withholding Tax Guide (June 2026), Example #2",
    // "$935.00 less $576.92 less $384.62 … would have $0 withheld" — negative, printed as $0.
    answers: { marital_status: "D", dependent_allowances: "2" },
    input: { payDate: "2026-06-15", periodsPerYear: 26, wages: "935.00" },
    expectedFactors: { GA_TAXABLE: "0" },
    expectedTax: "0",
  },
  {
    state: "GA", year: 2026, label: "December 2025 example — semi-monthly $1,470.83 at 5.19%: $15.79",
    citation: "Georgia Employer's Withholding Tax Guide (December 2025), worked example",
    // $1,470.83 − $1,000.00 − $166.67 = $304.16 × 0.0519.
    answers: { marital_status: "C", dependent_allowances: "1" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1470.83" },
    expectedFactors: { GA_RATE: "0.0519", GA_TAXABLE: "304.16" },
    expectedTax: "15.79",
  },

  // NORTH CAROLINA — NC-30 (2026)
  {
    state: "NC", year: 2026, label: "percentage method example — weekly $450, single, 2 allowances: $4.00",
    citation: "NC-30 (2026) p. 18, percentage method example",
    // 450 − 245.19 − 2 × 48.08 = 108.65 × .0409, rounded to the whole dollar.
    answers: { filing_status: "single_or_separate", allowances: "2" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "450.00" },
    expectedFactors: { NC_STANDARD_DEDUCTION: "245.19", NC_ALLOWANCES: "96.16", NC_NET_WAGES: "108.65" },
    expectedTax: "4",
  },
  {
    state: "NC", year: 2026, label: "withholds at 4.09% (not the 3.99% income tax rate) and rounds to the dollar — weekly $1,000: $31",
    citation: "NC-30 (2026) formula tables: \"3.99% plus 0.1% … a withholding tax rate of 4.09%\"",
    // 754.81 × .0409 = 30.87 → $31; at 3.99% it would be 30.12 → $30.
    answers: { filing_status: "single_or_separate" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { NC_NET_WAGES: "754.81" },
    expectedTax: "31",
  },
  {
    state: "NC", year: 2026, label: "head-of-household schedule — weekly $1,000: $26",
    citation: "NC-30 (2026) head of household standard deduction",
    answers: { filing_status: "head_household" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { NC_STANDARD_DEDUCTION: "367.79" },
    expectedTax: "26", // 632.21 × .0409 = 25.86
  },
  {
    state: "NC", year: 2026, label: "NC-4 NRA always uses the single schedule — head of household with $11 Line 2: $42",
    citation: "NC-30 (2026) § 13, Form NC-4 NRA instructions",
    answers: {
      filing_status: "head_household", allowances: "0", additional_per_period: "11",
      nonresident_alien: "true", india_student_or_apprentice_resident: "false",
    },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident" },
    expectedTax: "42", // single schedule $31 plus the full Line 2 $11
  },
  {
    state: "NC", year: 2026, label: "NC-4 NRA limits Line 2 for low wages — monthly $500: $21",
    citation: "NC-30 (2026) § 13, Form NC-4 NRA $500 monthly example",
    answers: {
      filing_status: "head_household", additional_per_period: "44",
      nonresident_alien: "true", india_student_or_apprentice_resident: "false",
    },
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "500.00", basis: "nonresident" },
    expectedFactors: { NC_NRA_ADDITIONAL_CAP: "21" },
    expectedTax: "21",
  },
  {
    state: "NC", year: 2026, label: "NC-4 NRA student or apprentice resident of India: no Line 2 adjustment",
    citation: "NC-30 (2026) § 13, Form NC-4 NRA instructions",
    answers: { additional_per_period: "0", nonresident_alien: "true", india_student_or_apprentice_resident: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "500.00", basis: "nonresident" },
    expectedTax: "0",
  },
  {
    state: "NC", year: 2026, label: "unprinted quarterly frequency uses the annualized method — $10,000: $279",
    citation: "NC-30 (2026) § 27, annualized method",
    // $40,000 − $12,750 = $27,250 × 4.09% = $1,114.53 a year.
    input: { payDate: "2026-03-06", periodsPerYear: 4, wages: "10000" },
    expectedFactors: { NC_ANNUAL_TAX: "1114.53" },
    expectedTax: "279",
  },
  // ALABAMA — ALDOR Withholding Tax Tables and Instructions (formula method, M-2 / $850 weekly example)
  {
    state: "AL", year: 2026, label: "official example — M-2, $850 weekly, FIT $35.19: $29.59",
    citation: "ALDOR withholding booklet, formula method worked example",
    // $850 × 52 = $44,200; SD $5,000; "M" $3,000; 2 × $1,000. FIT is printed as $35.19 × 52 =
    // $1,830.00, but 35.19 × 52 is $1,829.88 — the engine annualizes exactly; the tax is $29.59 either way.
    answers: { exemption: "M", dependents: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00", federalIncomeTax: "35.19" },
    expectedFactors: {
      AL_GI: "44200", AL_STANDARD_DEDUCTION: "5000", AL_FEDERAL_ANNUAL: "1829.88",
      AL_PERSONAL_EXEMPTION: "3000", AL_DEPENDENTS: "2000",
    },
    expectedTax: "29.59",
  },
  {
    state: "AL", year: 2026, label: "A4-MS with every attestation and supporting record withholds nothing",
    citation: "Form A4-MS; ALDOR military-spouse FAQ (employer-retained records)",
    answers: { exemption: "0", dependents: "0" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00", basis: "nonresident",
      supportingCertificates: {
        us_al_a4_ms: resolvedCertificate(payrollCertificate("US", "us_al_a4_ms"), Object.fromEntries([
          "spouse_is_active_duty_member", "employee_is_not_servicemember", "current_orders_assign_al",
          "employee_here_to_accompany", "same_current_address", "employee_domicile_outside_al", "same_domicile",
          "military_id_on_file", "dd2058_on_file", "recent_les_on_file",
        ].map((key) => [key, "true"]))),
      },
    },
    expectedTax: "0",
  },
  {
    state: "AL", year: 2026, label: "nonresident at 30 approved service days is safe-harbor exempt",
    citation: "Act 2025-334; ALDOR 2026 withholding booklet p. 3",
    answers: { exemption: "0", dependents: "0" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 52, wages: "10000.00", basis: "nonresident",
      wageAllocations: [{
        region: "AL", subRegion: null, workShare: "1", source: "approved Alabama service-day records",
        serviceDaysCurrentPeriod: 2, serviceDaysYearToDate: 30,
      }],
    },
    expectedTax: "0",
  },
  // ARKANSAS — DFA 2026 Withholding Formula
  {
    state: "AR", year: 2026, label: "formula example — monthly $2,127, 2 exemptions, $25 AR4EC extra: $61.50",
    citation: "Arkansas DFA 2026 Formula Method, worked example",
    // $25,524 − $2,470 std deduction = $23,054 → midrange $23,050 × 3.4% − $287.97 = $495.73 → $496;
    // credits 2 × $29 = $58; annual $438 → $36.50 + $25.
    answers: { exemptions: "2", additional_per_period: "25.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2127.00" },
    expectedFactors: {
      AR_ANNUAL_WAGES: "25524", AR_NET_TAXABLE: "23054", AR_MIDRANGE: "23050",
      AR_ADDITIONAL_WITHHOLDING: "25", AR_PERSONAL_CREDITS: "58", AR_ANNUAL_NET_TAX: "438",
    },
    expectedTax: "61.50",
  },
  ...([[null, "no AR4EC on file"], [{ exemptions: "0" }, "an AR4EC claiming zero exemptions"]] as const)
    .map(([answers, what]): Golden => ({
      state: "AR", year: 2026, label: `${what} withholds at zero exemptions: $41.33`,
      citation: "Arkansas DFA 2026 Formula Method, AR4EC instructions",
      answers, input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2127.00" },
      expectedFactors: { AR_PERSONAL_CREDITS: "0" },
      expectedTax: "41.33",
    })),
  {
    state: "AR", year: 2026, label: "low-income single $16,000 annual: $124.28 after the $58.72 credit",
    citation: "Arkansas DFA 2026 Formula Method, low-income (NFC) credit",
    // Gross $183 (13,550 × 3% − 223.97) minus the $58.72 credit; zero exemptions, so no $29 credits.
    answers: { low_income: "true", filing_status: "single" },
    input: { payDate: "2026-03-15", periodsPerYear: 1, wages: "16000" },
    expectedTax: "124.28",
  },
  {
    state: "AR", year: 2026, label: "an exempt AR4EC withholds nothing",
    citation: "Form AR4EC, exemption claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2127.00" },
    expectedTax: "0",
  },
  // ARIZONA — Form A-4 (2026); ADOR publishes no dollar worked example, so these are the form's own arithmetic
  {
    state: "AZ", year: 2026, label: "Form A-4 — 2.0% of $1,000.00 gross taxable wages: $20.00",
    citation: "Arizona Form A-4 (2026), line 1",
    // "The amount withheld is a percentage of your gross taxable wages from every paycheck."
    answers: { withholding_percent: "2.0" },
    input: { payDate: "2026-03-13", periodsPerYear: 26, wages: "1000.00" },
    expectedTax: "20",
  },
  {
    state: "AZ", year: 2026, label: "Form A-4 — 2.5% of $2,400.00: $60.00",
    citation: "Arizona Form A-4 (2026), line 1 (2.5% is the statutory rate ADOR prints beside the boxes)",
    answers: { withholding_percent: "2.5" },
    input: { payDate: "2026-03-13", periodsPerYear: 26, wages: "2400.00" },
    expectedTax: "60",
  },
  {
    state: "AZ", year: 2026, label: "Form A-4 line 1 extra $15 is added AFTER the percent: $35",
    citation: "Arizona Form A-4 (2026), line 1 extra amount",
    answers: { withholding_percent: "2.0", additional_per_period: "15.00" },
    input: { payDate: "2026-03-13", periodsPerYear: 26, wages: "1000.00" },
    expectedFactors: { AZ_TAX: "20", AZ_EXTRA: "15" },
    expectedTax: "35",
  },
  {
    state: "AZ", year: 2026, label: "no A-4 on file withholds the form's stated 2.0% default: $20",
    citation: "A.R.S. § 43-401(E); Arizona Form A-4 (2026) default percentage",
    answers: null,
    input: { payDate: "2026-03-13", periodsPerYear: 26, wages: "1000.00" },
    expectedTax: "20",
  },
  ...[52, 13].map((periodsPerYear): Golden => ({
    state: "AZ", year: 2026, label: `a percent of wages at any frequency — ${periodsPerYear} periods, 2.0% of $1,000: $20`,
    citation: "Arizona Form A-4 (2026): a percentage of gross taxable wages from every paycheck",
    answers: { withholding_percent: "2.0" },
    input: { payDate: "2026-03-06", periodsPerYear, wages: "1000.00" },
    expectedTax: "20",
  })),
  {
    state: "AZ", year: 2026, label: "nonresident under 60 service days is exempt",
    citation: "Arizona nonresident under-60-day withholding exclusion",
    answers: null,
    input: {
      payDate: "2026-03-13", periodsPerYear: 26, wages: "1000.00", basis: "nonresident",
      wageAllocations: [{
        region: "AZ", subRegion: null, workShare: "1", source: "approved_time_entries", serviceDaysCurrentPeriod: 2,
        serviceDaysYearToDate: 59, sourceWagesCurrentPeriod: "1000.00", sourceWagesYearToDate: null,
      }],
    },
    expectedTax: "0",
  },
  // COLORADO — DR 1098 (2026) worksheet; Colorado Wage Withholding Tax Guide (Jan. 2026)
  {
    state: "CO", year: 2026, label: "DR 1098 — weekly $1,000, W-4 single status, no DR 0004 allowance: $39.35",
    citation: "Colorado DR 1098 (2026) worksheet",
    // 1c $52,000 − 2a $5,500 = $46,500 × 4.40% = $2,046.00 ÷ 52 = $39.3461… → $39.35.
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", federalFilingStatus: "single" },
    expectedFactors: { CO_ANNUAL_ALLOWANCE: "5500" },
    expectedTax: "39.35",
  },
  {
    state: "CO", year: 2026, label: "DR 1098 — weekly $1,000, married filing jointly default: $34.69",
    citation: "Colorado DR 1098 (2026) worksheet",
    // 1c $52,000 − 2a $11,000 = $41,000 × 4.40% = $1,804.00 ÷ 52 = $34.6923… → $34.69.
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", federalFilingStatus: "married_joint" },
    expectedFactors: { CO_ANNUAL_ALLOWANCE: "11000" },
    expectedTax: "34.69",
  },
  {
    state: "CO", year: 2026, label: "DR 0004 line 2 overrides the W-4 default: $44.00",
    citation: "Colorado DR 1098 (2026) worksheet; DR 0004 line 2",
    // $52,000 × 4.40% = $2,288.00 ÷ 52.
    answers: { annual_allowance: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", federalFilingStatus: "married_joint" },
    expectedFactors: { CO_ANNUAL_ALLOWANCE: "0" },
    expectedTax: "44.00",
  },
  {
    state: "CO", year: 2026, label: "extra $25 is added after the rate: $64.35",
    citation: "Colorado DR 1098 (2026) worksheet; DR 0004 extra withholding",
    answers: { additional_per_period: "25" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", federalFilingStatus: "single" },
    expectedTax: "64.35",
  },
  {
    state: "CO", year: 2026, label: "the published 260-day basis: $43.07",
    citation: "Colorado DR 1098 (2026) worksheet, daily pay periods",
    input: { payDate: "2026-03-06", periodsPerYear: 260, wages: "1000.00", federalFilingStatus: "single" },
    expectedTax: "43.07",
  },
  {
    state: "CO", year: 2026, label: "a W-4-only exempt claim withholds nothing",
    citation: "Colorado DR 1098 (2026) and Wage Withholding Tax Guide (Jan. 2026), W-4-only exemption",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", federalTaxExempt: true, stateCertificateOnFile: false,
    },
    expectedTax: "0",
  },
  {
    state: "CO", year: 2026, label: "a filed DR 0004 resumes its worksheet despite a federal exempt claim: $44.00",
    citation: "Colorado DR 1098 (2026) and Wage Withholding Tax Guide (Jan. 2026), W-4-only exemption",
    answers: { annual_allowance: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", federalTaxExempt: true, stateCertificateOnFile: true,
    },
    expectedTax: "44.00",
  },
  {
    state: "CO", year: 2026, label: "DR 1059 with every current-year attestation withholds nothing",
    citation: "Colorado DR 1059 (qualifying military spouse)",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      supportingCertificates: {
        us_co_dr1059: resolvedCertificate(payrollCertificate("US", "us_co_dr1059"), Object.fromEntries([
          "spouse_is_nonresident", "servicemember_is_member", "servicemember_is_nonresident",
          "spouse_present_to_accompany", "servicemember_serving_under_orders", "notify_if_residency_changes",
        ].map((key) => [key, "true"]))),
      },
    },
    expectedTax: "0",
  },
  {
    state: "CO", year: 2026, label: "nonresident wages apportioned by a 50% service-day share: $17.35",
    citation: "Colorado Wage Withholding Tax Guide (Jan. 2026), Nonresident Employees",
    // Apportion first: $500 × 52 − $5,500 = $20,500; × 4.40% ÷ 52.
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident", federalFilingStatus: "single",
      wageAllocations: [{ region: "CO", subRegion: null, workShare: "0.5", source: "verified Colorado service-day records" }],
    },
    expectedFactors: { CO_NONRESIDENT_WAGES: "500" },
    expectedTax: "17.35",
  },
  ...(["nonresident", "resident"] as const).map((basis): Golden => ({
    state: "CO", year: 2026,
    label: `classified rail and motor carrier pay — ${basis}: ${basis === "nonresident" ? "excluded, $0" : "stays taxable, $39.35"}`,
    citation: "49 USC 11502 and 14503; Colorado Wage Withholding Tax Guide (Jan. 2026)",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis, federalFilingStatus: "single",
      statutoryExemptionAmounts: [{ category: "rail_carrier", amount: "600.00" }, { category: "motor_carrier", amount: "400.00" }],
      ...(basis === "nonresident"
        ? { wageAllocations: [{ region: "CO", subRegion: null, workShare: "1", source: "verified carrier route records" }] }
        : {}),
    },
    expectedFactors: basis === "nonresident" ? { CO_EXEMPT_CARRIER_WAGES: "1000" } : {},
    expectedTax: basis === "nonresident" ? "0" : "39.35",
  })),
  // CONNECTICUT — Circular CT (Issued 12/12/2025); TPG-211 (Rev. 12/25) calculation rules, Tables A–E
  {
    state: "CT", year: 2026, label: "no completed CT-W4 withholds 6.99% with no exemption: $69.90",
    citation: "Circular CT p. 11",
    // "you must withhold at a flat rate of 6.99%, without allowance for exemption." 6.99% of $1,000.00.
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "69.90",
  },
  {
    state: "CT", year: 2026, label: "CT-W4 Code E stops withholding",
    citation: "Form CT-W4, Withholding Code E",
    answers: { withholding_code: "E" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "0",
  },
  // Circular CT Examples 8–10 are wage-bracket TABLE cells ($17.65 / $10.59, $39.97, $78.82). TPG-211 allows
  // either the tables or the calculation rules and they differ by cents; the engine is the calculation rules,
  // so these rows assert the rules' figures and the table cells are deliberately NOT the expectation.
  {
    state: "CT", year: 2026, label: "Circular CT Example 8 — weekly $700 Code F by the calculation rules: $17.79 (table $17.65)",
    citation: "Circular CT Example 8; TPG-211 (Rev. 12/25) Tables A–E",
    // $36,400; Table A Code F $36,000–$37,000 → $8,000; $28,400; Table B $200 + 4.5% × $18,400 = $1,028;
    // Tables C, D $0; Table E 0.10; $1,028 × 0.90 = $925.20 ÷ 52. No CT-W4NA, so no silent 60% ($10.59).
    answers: { withholding_code: "F" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00", basis: "nonresident" },
    expectedFactors: {
      CT_ANNUAL_WAGES: "36400", CT_EXEMPTION: "8000", CT_TAXABLE: "28400", CT_INITIAL_TAX: "1028", CT_AFTER_CREDIT: "925.20",
    },
    expectedTax: "17.79",
  },
  {
    state: "CT", year: 2026, label: "Example 8's nonresident with five verified Connecticut days in the year withholds nothing",
    citation: "Circular CT p. 8, nonresident day threshold",
    answers: { withholding_code: "F" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00", basis: "nonresident",
      wageAllocations: [{
        region: "CT", subRegion: null, workShare: "1", source: "CT-W4NA allocation records",
        serviceDaysCurrentPeriod: 2, serviceDaysYearToDate: 5,
      }],
    },
    expectedTax: "0",
  },
  {
    state: "CT", year: 2026, label: "Circular CT Example 9 — weekly $1,000 Code A by the calculation rules: $40.24 (table $39.97)",
    citation: "Circular CT Example 9; TPG-211 (Rev. 12/25) Tables A–E",
    // $52,000; Table A $0; Table B $2,000 + 5.5% × $2,000 = $2,110; Table C $25; Table D $0;
    // Table E 0.02; ($2,110 + $25) × 0.98 = $2,092.30 ÷ 52.
    answers: { withholding_code: "A" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: {
      CT_ANNUAL_WAGES: "52000", CT_EXEMPTION: "0", CT_INITIAL_TAX: "2110", CT_PHASE_OUT: "25", CT_RECAPTURE: "0",
      CT_AFTER_CREDIT: "2092.30",
    },
    expectedTax: "40.24",
  },
  {
    state: "CT", year: 2026, label: "Circular CT Example 10 — biweekly $2,300 Code B by the calculation rules: $79.30 (table $78.82)",
    citation: "Circular CT Example 10; TPG-211 (Rev. 12/25) Tables A–E",
    // $59,800; Table A $0; Table B $320 + 4.5% × $43,800 = $2,291; Tables C, D $0; Table E 0.10;
    // $2,291 × 0.90 = $2,061.90 ÷ 26.
    answers: { withholding_code: "B" },
    input: { payDate: "2026-03-15", periodsPerYear: 26, wages: "2300.00", basis: "nonresident" },
    expectedFactors: { CT_ANNUAL_WAGES: "59800", CT_EXEMPTION: "0", CT_INITIAL_TAX: "2291", CT_AFTER_CREDIT: "2061.90" },
    expectedTax: "79.30",
  },
  {
    state: "CT", year: 2026, label: "extra $10 is added to Example 9's $40.24: $50.24",
    citation: "TPG-211 (Rev. 12/25) Steps 14–16",
    answers: { withholding_code: "A", additional_per_period: "10.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "50.24",
  },
  {
    state: "CT", year: 2026, label: "reduced $100 is subtracted from Example 9's $40.24 and floors at zero",
    citation: "TPG-211 (Rev. 12/25) Steps 14–16",
    answers: { withholding_code: "A", reduced_per_period: "100.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "0",
  },
  // DISTRICT OF COLUMBIA — FR-230 (Rev. 11/17) percentage method with OTR Tax Notice 2022-08's current
  // schedule and the Pub 15-T (2026) $4,300 allowance. The District prints no worked example, so each row is
  // worked by hand through FR-230's three steps.
  {
    state: "DC", year: 2026, label: "weekly $1,000 with no allowances: $57.31",
    citation: "FR-230 percentage method; OTR Tax Notice 2022-08",
    // Weekly B3 (over $769.23, base $42.31, 6.5%): 42.31 + 6.5% × (1,000 − 769.23) = 42.31 + 15.00.
    answers: { allowances: "0" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { DC_WAGES: "1000", DC_ALLOWANCE_PER_PERIOD: "82.69", DC_ALLOWANCE: "0", DC_TAXABLE: "1000" },
    expectedResult: { taxSupplemental: "0" },
    expectedTax: "57.31",
  },
  {
    state: "DC", year: 2026, label: "no D-4 on file withholds on the full wage: $57.31",
    citation: "FR-230 percentage method; OTR Tax Notice 2022-08",
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { DC_ALLOWANCE: "0" },
    expectedTax: "57.31",
  },
  {
    state: "DC", year: 2026, label: "biweekly $3,000 with 2 allowances: $165.35",
    citation: "FR-230 percentage method; OTR Tax Notice 2022-08",
    // 2 × $165.38 = $330.76; $2,669.24. Biweekly B4 (over $2,307.69, base $134.62, 8.5%): 134.62 + 30.73.
    answers: { allowances: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 26, wages: "3000.00" },
    expectedFactors: { DC_ALLOWANCE: "330.76", DC_TAXABLE: "2669.24" },
    expectedTax: "165.35",
  },
  {
    state: "DC", year: 2026, label: "supplemental wages are ordinary wages — biweekly $3,000 + $1,000, 2 allowances: $250.35",
    citation: "FR-230 wages definition (bonuses and commissions); no supplemental rule printed",
    // Taxable $3,669.24, biweekly B4: 134.62 + 8.5% × 1,361.55 = 134.62 + 115.73.
    answers: { allowances: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 26, wages: "3000.00", supplemental: "1000.00" },
    expectedFactors: { DC_WAGES: "4000" },
    expectedResult: { taxSupplemental: "0" },
    expectedTax: "250.35",
  },
  {
    state: "DC", year: 2026, label: "monthly $20,000 with 1 allowance: $1,536.21",
    citation: "FR-230 percentage method; OTR Tax Notice 2022-08",
    // $358.33; $19,641.67. Monthly B4 (over $5,000, base $291.67, 8.5%): 291.67 + 8.5% × 14,641.67 = 291.67 + 1,244.54.
    answers: { allowances: "1" },
    input: { payDate: "2026-06-30", periodsPerYear: 12, wages: "20000.00" },
    expectedFactors: { DC_ALLOWANCE: "358.33", DC_TAXABLE: "19641.67" },
    expectedTax: "1536.21",
  },
  {
    state: "DC", year: 2026, label: "semimonthly $500 with no allowances: $21.67",
    citation: "FR-230 percentage method; OTR Tax Notice 2022-08",
    // Semimonthly B2 (over $416.67, base $16.67, 6%): 16.67 + 6% × 83.33 = 16.67 + 5.00.
    answers: { allowances: "0" },
    input: { payDate: "2026-02-15", periodsPerYear: 24, wages: "500.00" },
    expectedTax: "21.67",
  },
  {
    state: "DC", year: 2026, label: "annual $100,000 with 1 allowance: $6,534.50",
    citation: "FR-230 percentage method; OTR Tax Notice 2022-08",
    // Taxable $95,700. Annual B4: 3,500 + 8.5% × 35,700 = 3,500 + 3,034.50.
    answers: { allowances: "1" },
    input: { payDate: "2026-12-31", periodsPerYear: 1, wages: "100000.00" },
    expectedTax: "6534.50",
  },
  ...[365, 260].map((periodsPerYear): Golden => ({
    state: "DC", year: 2026, label: `daily $400 with no allowances on the 365-day divisor (${periodsPerYear} periods): $29.62`,
    citation: "FR-230 daily table (365-based); OTR Tax Notice 2022-08",
    // Daily B4 (over $164.38, base $9.59, 8.5%): 9.59 + 8.5% × 235.62 = 9.59 + 20.03.
    answers: { allowances: "0" },
    input: { payDate: "2026-04-01", periodsPerYear, wages: "400.00" },
    expectedFactors: { DC_ALLOWANCE_PER_PERIOD: "11.78" },
    expectedTax: "29.62",
  })),
  {
    state: "DC", year: 2026, label: "allowances beyond wages floor at zero, never a refund",
    citation: "FR-230 percentage method",
    answers: { allowances: "10" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "50.00" },
    expectedFactors: { DC_TAXABLE: "0" },
    expectedTax: "0",
  },
  {
    state: "DC", year: 2026, label: "an exempt D-4 withholds nothing",
    citation: "Form D-4, exemption claim",
    answers: { allowances: "0", exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "0",
  },
  {
    state: "DC", year: 2026, label: "a D-4A verified Maryland resident withholds nothing",
    citation: "Form D-4A, certificate of nonresidence",
    input: {
      payDate: "2026-03-15", periodsPerYear: 26, wages: "2300.00", basis: "nonresident", residenceRegion: "MD",
      certificateFor: () => resolvedCertificate(payrollCertificate("US", "us_dc_d4a"), {
        permanent_residence_region: "MD", days_in_dc: "42",
      }),
    },
    expectedTax: "0",
  },
  // DELAWARE — Division of Revenue Employer's Guide, Section 17 examples and Tax Computation Table
  ...([
    ["single", "1", "3250", "21750", "832", "110", "722"],
    ["married_joint", "3", "6500", "18500", "669", "330", "339"],
    ["married_separate", "2", "3250", "21750", "832", "220", "612"],
  ] as const).map(([filing_status, allowances, deduction, taxable, annualTax, credit, net]): Golden => ({
    state: "DE", year: 2026, label: `Section 17 — ${filing_status}, ${allowances} allowance(s), $25,000 annual: $${net}`,
    citation: "Delaware Employer's Guide, Section 17 example",
    // e.g. single: "Tax on $21,750.00 ($741.00 + $91.00 [$1,750.00 x 5.20%])" = $832 minus $110 = $722.
    // $25,000 does not divide evenly by 52, so the example is pinned on the annual path; the
    // publication's own ÷ P lines are asserted from this row's tax in the extras.
    answers: { filing_status, allowances },
    input: { payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00" },
    expectedFactors: {
      DE_ANNUAL_WAGES: "25000", DE_STANDARD_DEDUCTION: deduction, DE_TAXABLE: taxable, DE_ANNUAL_TAX: annualTax,
      DE_EXEMPTION_CREDIT: credit, DE_AFTER_CREDIT: net,
    },
    expectedTax: net,
  })),
  ...([[null, "no certificate"], [{ filing_status: "single", allowances: "0" }, "single with zero allowances"]] as const)
    .map(([answers, what]): Golden => ({
      state: "DE", year: 2026, label: `${what} withholds as single, 0 on $25,000 annual: $832`,
      citation: "Delaware Employer's Guide, Section 17 Tax Computation Table",
      answers, input: { payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00" },
      expectedFactors: { DE_EXEMPTION_CREDIT: "0" },
      expectedTax: "832",
    })),
  {
    state: "DE", year: 2026, label: "extra $10 is added to the Section 17 single $722: $732",
    citation: "Delaware Employer's Guide, Section 17; Form W-4 extra withholding",
    answers: { filing_status: "single", allowances: "1", additional_per_period: "10.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00" },
    expectedTax: "732",
  },
  {
    state: "DE", year: 2026, label: "an exempt certificate withholds nothing",
    citation: "Delaware Employer's Guide, exemption claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "0",
  },
  {
    state: "DE", year: 2026, label: "nonresident W-4NR 2 of 5 Delaware days prorates the $44.60 total-wage tax: $17.84",
    citation: "Delaware Employer's Guide, Section 16; Form W-4NR",
    answers: { filing_status: "single", allowances: "0" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      supportingCertificates: {
        us_de_w4nr: resolvedCertificate(payrollCertificate("US", "us_de_w4nr"), {
          delaware_work_days: "2", total_work_days: "5",
        }),
      },
    },
    expectedTax: "17.84",
  },
  // HAWAII — Booklet A (Rev. 2025) and Form HW-4 (Rev. 2022)
  {
    state: "HI", year: 2026, label: "Booklet A example — $500 weekly, single, 3 allowances: $9.58",
    citation: "Hawaii Booklet A (Rev. 2025), worked example",
    // $26,000 − 3 × $1,144 − $4,350 = $18,218; $288 + $3,818 × 5.5% = $497.99 ÷ 52.
    answers: { filing_status: "single", allowances: "3" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedFactors: {
      HI_ANNUAL_WAGES: "26000", HI_ALLOWANCES: "3432", HI_LUMP_SUM: "4350", HI_TAXABLE: "18218", HI_ANNUAL_TAX: "497.99",
    },
    expectedTax: "9.58",
  },
  {
    state: "HI", year: 2026, label: "HW-4 extra $5 is added to the Booklet A example: $14.58",
    citation: "Hawaii Booklet A (Rev. 2025); Form HW-4 additional withholding",
    answers: { filing_status: "single", allowances: "3", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedTax: "14.58",
  },
  // Married may elect the higher Single rate: the election and Single both withhold $13.63; Married $6.68.
  ...([["married_single_rate", "13.63"], ["single", "13.63"], ["married", "6.68"]] as const)
    .map(([filing_status, tax]): Golden => ({
      state: "HI", year: 2026, label: `$500 weekly, HW-4 status ${filing_status}, no allowances: $${tax}`,
      citation: "Form HW-4 (Rev. 2022) status boxes; Hawaii Booklet A (Rev. 2025) annualized schedules",
      answers: { filing_status },
      input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
      expectedTax: tax,
    })),
  {
    state: "HI", year: 2026, label: "certified-disabled status with the Department certification on file is not subject",
    citation: "Hawaii Booklet A (Rev. 2025) section 11(b), (g); Form HW-4 (Rev. 2022)",
    answers: { filing_status: "certified_disabled", disability_certification_on_file: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedTax: "0",
  },
  {
    state: "HI", year: 2026, label: "nonresident military spouse with every statutory fact is not subject",
    citation: "Hawaii Booklet A (Rev. 2025) section 11(b), (g); Form HW-4 (Rev. 2022)",
    answers: {
      filing_status: "nonresident_military_spouse", servicemember_present_under_orders: "true",
      spouse_present_to_accompany: "true", same_non_hawaii_domicile: "true",
    },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedTax: "0",
  },
  // IA — Iowa Withholding Formula For Taxable Wages Paid Beginning January 1, 2026 (Released November 2025)
  {
    state: "IA", year: 2026, label: "Example 1 — biweekly $2,100, Other, $40 allowance: $59.26",
    citation: "Iowa 2026 Withholding Formula, Example 1",
    // T1 = $2,100 − $500 (column A) = $1,600; T2 = × 3.80% = $60.80; T3 = $60.80 − $40 / 26.
    answers: { filing_status: "other", total_allowance: "40" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    expectedFactors: { IA_DEDUCTION: "500.00", IA_T1: "1600", IA_T2: "60.80", IA_T3: "59.26" },
    expectedTax: "59.26",
  },
  {
    state: "IA", year: 2026, label: "Example 2 — biweekly $2,100, MFJ spouse no earned income, $80: $38.72",
    citation: "Iowa 2026 Withholding Formula, Example 2",
    answers: { filing_status: "married_joint", total_allowance: "80" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    expectedFactors: { IA_DEDUCTION: "1000.00", IA_T2: "41.80" },
    expectedTax: "38.72",
  },
  {
    state: "IA", year: 2026, label: "Example 3 — biweekly $2,100, Head of Household, $160: $45.15",
    citation: "Iowa 2026 Withholding Formula, Example 3",
    answers: { filing_status: "head_household", total_allowance: "160" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    expectedFactors: { IA_DEDUCTION: "750.00" },
    expectedTax: "45.15",
  },
  ...([
    [4, "other", "40", "3916.67", "148.83", "145.50"],
    [5, "married_joint", "80", "2833.33", "107.67", "101.00"],
    [6, "head_household", "160", "3375", "128.25", "114.92"],
  ] as const).map(([n, status, allowance, t1, t2, tax]): Golden => ({
    state: "IA", year: 2026, label: `Example ${n} — monthly $5,000, ${status}, $${allowance}: $${tax}`,
    citation: `Iowa 2026 Withholding Formula, Example ${n}`,
    answers: { filing_status: status, total_allowance: allowance },
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "5000.00" },
    expectedFactors: { IA_T1: t1, IA_T2: t2 },
    expectedTax: tax,
  })),
  // Examples 7–10: a 2023-or-earlier IA W-4 uses $40 per allowance, so each equals Examples 1, 2, 4, 5.
  ...([
    [7, "single", "1", 26, "2100.00", "59.26"],
    [8, "married", "2", 26, "2100.00", "38.72"],
    [9, "single", "1", 12, "5000.00", "145.50"],
    [10, "married", "2", 12, "5000.00", "101.00"],
  ] as const).map(([n, marital, allowances, periodsPerYear, wages, tax]): Golden => ({
    state: "IA", year: 2026, label: `Example ${n} — pre-2024 IA W-4, ${marital}, ${allowances} allowance(s): $${tax}`,
    citation: `Iowa 2026 Withholding Formula, Example ${n}`,
    answers: { pre_2024: "true", pre_2024_marital: marital, pre_2024_allowances: allowances },
    input: { payDate: "2026-03-06", periodsPerYear, wages },
    expectedTax: tax,
  })),
  {
    state: "IA", year: 2026, label: "MFJ with spouse earned income uses column A — Example 1's $59.26",
    citation: "Iowa 2026 Withholding Formula, column footnote (MFJ + spouse earned income → column A)",
    answers: { filing_status: "married_joint", spouse_earned_income: "true", total_allowance: "40" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    expectedFactors: { IA_DEDUCTION: "500.00" },
    expectedTax: "59.26",
  },
  {
    state: "IA", year: 2026, label: "no IA W-4 uses column A with no allowance: Example 1's T2 $60.80",
    citation: "IAC 701—307.3; Iowa 2026 Withholding Formula (missing status → column A)",
    answers: null,
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    expectedFactors: { IA_DEDUCTION: "500.00", IA_ALLOWANCE_ANNUAL: "0" },
    expectedTax: "60.80",
  },
  {
    state: "IA", year: 2026, label: "line 8 extra $15 is added after the rate: $74.26",
    citation: "Iowa 2026 Withholding Formula, T4; IA W-4 line 8",
    answers: { filing_status: "other", total_allowance: "40", additional_per_period: "15.00" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    expectedTax: "74.26",
  },
  {
    state: "IA", year: 2026, label: "an unlisted quarterly frequency annualizes: $185.70",
    citation: "Iowa 2026 Withholding Formula, \"pay period not provided\"",
    // $8,400 × 4 = $33,600 − annual D $13,000 = $20,600 × 3.80% = $782.80; ($782.80 − $40) ÷ 4.
    answers: { filing_status: "other", total_allowance: "40" },
    input: { payDate: "2026-03-06", periodsPerYear: 4, wages: "8400.00" },
    expectedFactors: { IA_DEDUCTION: "13000.00", IA_T1: "20600", IA_T2: "782.80" },
    expectedTax: "185.70",
  },
  {
    state: "IA", year: 2026, label: "an exempt IA W-4 withholds nothing",
    citation: "IA W-4 (2026), exemption claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    expectedTax: "0",
  },
  {
    state: "IA", year: 2026, label: "a nonresident's exempt claim is disregarded — Example 1's $59.26",
    citation: "IA W-4 (2026): nonresidents may not claim exemption",
    answers: { filing_status: "other", total_allowance: "40", exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "nonresident" },
    expectedTax: "59.26",
  },
  {
    state: "IA", year: 2026, label: "military-spouse exemption with every W-4 fact and the military ID on file",
    citation: "IA W-4 (2026), military spouse exemption",
    answers: {
      military_spouse_exempt: "true", servicemember_present_under_orders: "true",
      spouse_present_solely_to_accompany: "true", spouse_domiciled_outside_ia: "true",
      spousal_military_id_on_file: "true",
    },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    expectedTax: "0",
  },
  // ID — Idaho Computing Withholding, percentage table effective July 23 2026
  {
    state: "ID", year: 2026, label: "Computing Withholding example — $1,212 biweekly, unmarried, 4 allowances: $31",
    citation: "Idaho Computing Withholding, worked example (July 23 2026 table)",
    // Child-tax-credit allowance is $0 after the sunset. 5.3% of ($1,212 − $619) = $31.429 → $31.
    answers: { filing_status: "single", allowances: "4" },
    input: { payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00" },
    expectedFactors: { ID_WAGES: "1212", ID_ALLOWANCES: "0", ID_TAXABLE: "1212", ID_THRESHOLD: "619" },
    expectedTax: "31",
  },
  {
    state: "ID", year: 2026, label: "zero allowances equals four after the sunset: $31",
    citation: "Idaho Computing Withholding, worked example (July 23 2026 table)",
    answers: { filing_status: "single", allowances: "0" },
    input: { payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00" },
    expectedFactors: { ID_ALLOWANCES: "0" },
    expectedTax: "31",
  },
  {
    state: "ID", year: 2026, label: "ID W-4 line 2 extra $5 is added: $36",
    citation: "Form ID W-4 line 2",
    answers: { filing_status: "single", allowances: "4", additional_per_period: "5.00" },
    input: { payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00" },
    expectedTax: "36",
  },
  {
    state: "ID", year: 2026, label: "an exempt ID W-4 withholds nothing",
    citation: "Form ID W-4, exemption claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00" },
    expectedTax: "0",
  },
  {
    state: "ID", year: 2026, label: "a nonresident with under $1,000 of Idaho pay for the year is not withheld",
    citation: "Idaho Income Tax Withholding, \"Income You Don't Have to Withhold On\"",
    answers: { filing_status: "single" },
    input: {
      payDate: "2026-08-15", periodsPerYear: 260, wages: "900.00", basis: "nonresident",
      wageAllocations: [{
        region: "ID", subRegion: null, workShare: "1", source: "approved_time_entries",
        sourceWagesCurrentPeriod: "900", sourceWagesYearToDate: "0", periodsYearToDate: 1,
      }],
    },
    expectedTax: "0",
  },
  // IN — Indiana Departmental Notice #1 (R46 / 01-26)
  {
    state: "IN", year: 2026, label: "DN#1 weekly example — $800, five/three/one/two exemptions: $13.96",
    citation: "Indiana Departmental Notice #1 (R46 01-26), p. 3",
    // Deduction constant $96.15 + $86.54 + $28.85 + $115.38 = $326.92; $473.08 × .0295 = $13.96.
    answers: {
      personal_exemptions: "5", additional_dependent_exemptions: "3",
      first_time_dependent_exemptions: "1", adopted_dependent_exemptions: "2",
    },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedFactors: { IN_PERIOD_EXEMPTION: "326.92", IN_TAXABLE: "473.08" },
    expectedTax: "13.96",
  },
  {
    state: "IN", year: 2026, label: "WH-4 extra $10 is added after the 2.95% rate: $23.96",
    citation: "Indiana Departmental Notice #1 (R46 01-26), p. 3; WH-4 additional state withholding",
    answers: {
      personal_exemptions: "5", additional_dependent_exemptions: "3",
      first_time_dependent_exemptions: "1", adopted_dependent_exemptions: "2",
      additional_state_per_period: "10.00",
    },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedTax: "23.96",
  },
  {
    state: "IN", year: 2026, label: "no WH-4 withholds on the entire wage — zero exemptions: $23.60",
    citation: "Indiana Departmental Notice #1 (R46 01-26)",
    answers: null,
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedFactors: { IN_PERIOD_EXEMPTION: "0" },
    expectedTax: "23.60",
  },
  {
    state: "IN", year: 2026, label: "WH-4AFF county waiver leaves state tax whole: $23.60",
    citation: "Indiana Form WH-4AFF",
    answers: { county_exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedTax: "23.60",
  },
  {
    state: "IN", year: 2026, label: "bonus taxed at 2.95% with no exemptions: $5.90 + $20.76",
    citation: "Indiana Departmental Notice #1 (R46 01-26), supplemental wages",
    // Periodic ($800 − $96.15) × 2.95% = $20.76; bonus $200 × 2.95% = $5.90.
    answers: { personal_exemptions: "5" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", supplemental: "200.00" },
    expectedResult: { taxSupplemental: "5.90" },
    expectedTax: "26.66",
  },
  // KS — KW-100 Kansas Withholding Tax Guide, Esmeralda Espinoza walkthrough
  {
    state: "KS", year: 2026, label: "KW-100 example — Esmeralda $2,000 semi-monthly, married, 3 allowances: $41.44",
    citation: "Kansas KW-100, Esmeralda Espinoza example",
    // Allowance $763.33 + 1 × $96.67 = $860; $2,000 − $860 = $1,140; 5.2% × ($1,140 − $343) = $41.44.
    answers: { filing_status: "married", allowances: "3" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00" },
    expectedFactors: { KS_WAGES: "2000", KS_ALLOWANCE: "860", KS_TAXABLE: "1140" },
    expectedTax: "41.44",
  },
  {
    state: "KS", year: 2026, label: "K-4 extra $10 is added: $51.44",
    citation: "Kansas KW-100, Esmeralda Espinoza example; K-4 additional withholding",
    answers: { filing_status: "married", allowances: "3", additional_per_period: "10.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00" },
    expectedTax: "51.44",
  },
  {
    state: "KS", year: 2026, label: "an exempt K-4 withholds nothing",
    citation: "Kansas K-4, exemption claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00" },
    expectedTax: "0",
  },
  {
    state: "KS", year: 2026, label: "nonresident K-4C at 40% apportions Esmeralda's $41.44 to $16.58",
    citation: "Kansas KW-100, Esmeralda Espinoza example; Form K-4C",
    answers: { filing_status: "married", allowances: "3" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00", basis: "nonresident",
      supportingCertificates: {
        us_ks_k4c: resolvedCertificate(payrollCertificate("US", "us_ks_k4c"), { kansas_services_percentage: "40" }),
      },
    },
    expectedTax: "16.58",
  },
  // KY — 42A003 (TCF)(10-2025), 2026 Kentucky Withholding Tax Formula
  {
    state: "KY", year: 2026, label: "42A003 monthly example — $3,270: $104.65",
    citation: "Kentucky 42A003 (TCF)(10-2025), monthly example",
    // $39,240 − $3,360 = $35,880 × 3.5% = $1,255.80 ÷ 12.
    input: { payDate: "2026-03-31", periodsPerYear: 12, wages: "3270.00" },
    expectedFactors: { KY_ANNUAL_WAGES: "39240", KY_TAXABLE: "35880", KY_ANNUAL_TAX: "1255.80" },
    expectedTax: "104.65",
  },
  {
    state: "KY", year: 2026, label: "42A003 bi-weekly example's own arithmetic is $47.98, not the printed $47",
    citation: "Kentucky 42A003 (TCF)(10-2025), bi-weekly example",
    // A publication defect, quantified: step 3's "$35,730" is a typo for step 2's $35,640, and
    // $1,247.40 ÷ 26 = $47.9769… is $47.98 to the cent; the publication prints "$47".
    input: { payDate: "2026-03-13", periodsPerYear: 26, wages: "1500.00" },
    expectedFactors: { KY_ANNUAL_WAGES: "39000", KY_TAXABLE: "35640", KY_ANNUAL_TAX: "1247.40" },
    expectedTax: "47.98",
  },
  {
    state: "KY", year: 2026, label: "K-4 extra $10 is added after the 3.5% rate: $114.65",
    citation: "Kentucky 42A003 (TCF)(10-2025), monthly example; K-4 additional withholding",
    answers: { additional_per_period: "10.00" },
    input: { payDate: "2026-03-31", periodsPerYear: 12, wages: "3270.00" },
    expectedTax: "114.65",
  },
  {
    state: "KY", year: 2026, label: "a K-4 exemption stops withholding",
    citation: "Kentucky K-4, exemption claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-31", periodsPerYear: 12, wages: "3270.00" },
    expectedTax: "0",
  },
  // LA — R-1306 (1/26) Louisiana Withholding Tables and Instructions
  {
    state: "LA", year: 2026, label: "R-1306 Example 1 — $700 weekly, Block A = 1: $13.98",
    citation: "Louisiana R-1306 (1/26), Example 1",
    // (700 − 12,875/52) × 0.0309 = (700 − 247.60) × 0.0309.
    answers: { standard_deduction: "1" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00" },
    expectedFactors: { LA_WAGES: "700", LA_DEDUCTION: "247.60", LA_TAXABLE: "452.40" },
    expectedTax: "13.98",
  },
  {
    state: "LA", year: 2026, label: "R-1306 Example 2 — $4,600 biweekly, Block A = 2: $111.54",
    citation: "Louisiana R-1306 (1/26), Example 2",
    // (4,600 − 25,750/26) × 0.0309 = (4,600 − 990.38) × 0.0309.
    answers: { standard_deduction: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 26, wages: "4600.00" },
    expectedFactors: { LA_WAGES: "4600", LA_DEDUCTION: "990.38", LA_TAXABLE: "3609.62" },
    expectedTax: "111.54",
  },
  {
    state: "LA", year: 2026, label: "no L-4 withholds with no standard deduction — Formula 1: $21.63",
    citation: "Louisiana R-1306 (1/26), Formula 1 (700 × 0.0309)",
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00" },
    expectedFactors: { LA_DEDUCTION: "0" },
    expectedTax: "21.63",
  },
  {
    state: "LA", year: 2026, label: "L-4 Block A = 0 equals no L-4: $21.63",
    citation: "Louisiana R-1306 (1/26), Formula 1 (700 × 0.0309)",
    answers: { standard_deduction: "0" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00" },
    expectedTax: "21.63",
  },
  {
    state: "LA", year: 2026, label: "L-4 extra $5 is added: $18.98",
    citation: "Louisiana R-1306 (1/26), Example 1; L-4 additional withholding",
    answers: { standard_deduction: "1", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00" },
    expectedTax: "18.98",
  },
  // MD — 2026 Maryland Employer Withholding Guide (Rev. 12/2025); Withholding Tax Facts 2026; MW507
  // The Guide prints no worked dollar example; period rows are LABELLED SUBSTITUTES built from its tables.
  {
    state: "MD", year: 2026, label: "annual 3.20% single table cell through compute — $100,000: $7,950.00",
    citation: "Maryland Employer Withholding Guide 2026, p. 39 (3.20% single annual), labelled substitute",
    // $103,400 − $3,400 − 0 × $3,200 = $100,000 taxable.
    answers: { filing_status: "single", exemptions: "0", residence_county: "16" },
    input: { payDate: "2026-03-15", periodsPerYear: 1, wages: "103400.00" },
    expectedFactors: { MD_TAXABLE: "100000" },
    expectedTax: "7950",
  },
  {
    state: "MD", year: 2026, label: "weekly $1,000, one exemption, Montgomery 3.20%, single: $69.41",
    citation: "Maryland Employer Withholding Guide 2026, p. 39 first band 7.95%, labelled substitute",
    // $52,000 − $3,400 − $3,200 = $45,400 × 7.95% = $3,609.30 ÷ 52.
    answers: { filing_status: "single", exemptions: "1", residence_county: "16" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { MD_ANNUAL_WAGES: "52000", MD_ANNUAL_EXEMPTION: "6600", MD_TAXABLE: "45400" },
    expectedTax: "69.41",
  },
  {
    state: "MD", year: 2026, label: "no MW507 exemption count defaults to ONE, not zero: $69.41",
    citation: "Maryland Employer Withholding Guide 2026 (no-certificate default)",
    // Zero exemptions would leave $3,400 of annual exemption, not $6,600.
    answers: { residence_county: "16" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { MD_ANNUAL_EXEMPTION: "6600" },
    expectedTax: "69.41",
  },
  {
    state: "MD", year: 2026, label: "Carroll uses the 3.05% table, not the 3.03% actual rate: $68.10",
    citation: "Maryland Withholding Tax Facts 2026 (COM/RAD-098), table-grouping rule",
    // 3.05% table first band 7.80% × $45,400 = $3,541.20 ÷ 52; the 3.03% actual (7.78%) would give $67.93.
    answers: { filing_status: "single", exemptions: "1", residence_county: "07" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "68.10",
  },
  {
    state: "MD", year: 2026, label: "nonresident uses the special 2.25% table, no county local: $61.12",
    citation: "Maryland Employer Withholding Guide 2026, p. 6 (special nonresident rate)",
    // First annual band 7.00% × $45,400 = $3,178 ÷ 52.
    answers: { filing_status: "single", exemptions: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident" },
    expectedTax: "61.12",
  },
  {
    state: "MD", year: 2026, label: "MW507 extra $10 is added after the combined rate: $79.41",
    citation: "Maryland Employer Withholding Guide 2026; MW507 line 2",
    answers: { filing_status: "single", exemptions: "1", residence_county: "16", additional_per_period: "10.00" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "79.41",
  },
  ...(["exempt", "reciprocal_exempt", "pa_york_adams_local_exempt", "pa_other_local_exempt"] as const)
    .map((flag): Golden => ({
      state: "MD", year: 2026, label: `MW507 ${flag} stops withholding`,
      citation: "Form MW507 (COM/RAD-036 07/25), lines 3, 4, 6 and 7",
      answers: { [flag]: "true", residence_county: "16" },
      input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
      expectedTax: "0",
    })),
  {
    state: "MD", year: 2026, label: "MW507 line 5 PA domiciliary withholds LOCAL only: $27.94",
    citation: "Form MW507 line 5; Maryland Withholding Tax Facts 2026 (local on taxable income)",
    // Montgomery actual 3.20% × $45,400 = $1,452.80 ÷ 52 — not the $69.41 state + local.
    answers: { filing_status: "single", exemptions: "1", residence_county: "16", pa_state_exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "27.94",
  },
  {
    state: "MD", year: 2026, label: "MW507 line 8 with MW507M attestations and military ID withholds nothing",
    citation: "Form MW507 line 8; Form MW507M",
    answers: { military_spouse_exempt: "true", residence_county: "16" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00",
      supportingCertificates: {
        us_md_mw507m: resolvedCertificate(payrollCertificate("US", "us_md_mw507m"), Object.fromEntries([
          "employee_married_to_servicemember", "employee_domiciled_outside_md",
          "servicemember_duty_station_qualifies", "employee_in_md_only_to_be_with_spouse",
          "spousal_military_id_on_file",
        ].map((key) => [key, "true"]))),
      },
    },
    expectedFactors: { MD_MILITARY_SPOUSE_EXEMPT: "0.0001" },
    expectedTax: "0",
  },
  {
    state: "MD", year: 2026, label: "Anne Arundel local is the Guide's marginal slices on $60,000: $4,494",
    citation: "Maryland Employer Withholding Guide 2026, p. 9; Withholding Tax Facts 2026 (Anne Arundel)",
    // State $60,000 × 4.75% = $2,850; local $50,000 × 2.70% + $10,000 × 2.94% = $1,644.
    answers: { filing_status: "single", exemptions: "0", residence_county: "02" },
    input: { payDate: "2026-03-15", periodsPerYear: 1, wages: "63400.00" },
    expectedFactors: { MD_TAXABLE: "60000", MD_STATE_TAX: "2850", MD_LOCAL_TAX: "1644" },
    expectedTax: "4494",
  },
  {
    state: "MD", year: 2026, label: "Frederick local is a flat band rate on the whole $40,000: $3,000",
    citation: "Maryland Employer Withholding Guide 2026, p. 9 (Frederick .0275 for $25,001–$50,000)",
    // State $40,000 × 4.75% = $1,900; local $40,000 × 2.75% = $1,100, not a 2.25% slice plus 2.75%.
    answers: { filing_status: "single", exemptions: "0", residence_county: "11" },
    input: { payDate: "2026-03-15", periodsPerYear: 1, wages: "43400.00" },
    expectedFactors: { MD_TAXABLE: "40000", MD_LOCAL_TAX: "1100" },
    expectedTax: "3000",
  },
  {
    state: "MD", year: 2026, label: "weekly wages under the printed $96.00 floor withhold nothing",
    citation: "Maryland Employer Withholding Guide 2026, weekly minimum gross $96.00",
    // Zero exemptions, so without the floor $4,680 − $3,400 would be taxed.
    answers: { residence_county: "16", exemptions: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "90.00" },
    expectedTax: "0",
  },
  // ME — Maine 2026 Withholding Tables (Revised August 2026)
  {
    state: "ME", year: 2026, label: "Example 1 — $300 weekly, single, 2 allowances: $0",
    citation: "Maine 2026 Withholding Tables, Example 1",
    answers: { filing_status: "single", allowances: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "300.00" },
    expectedFactors: {
      ME_ANNUAL_WAGES: "15600", ME_ALLOWANCES: "10600", ME_STANDARD_DEDUCTION: "12850", ME_TAXABLE: "0",
    },
    expectedTax: "0",
  },
  {
    state: "ME", year: 2026, label: "Example 2 — $1,000 weekly, single, 2 allowances: $32",
    citation: "Maine 2026 Withholding Tables, Example 2",
    // $52,000 − $10,600 − $12,850 = $28,550; $1,589 + $1,150 × 6.75% = $1,666.625 → $1,667; ÷ 52 = $32.06 → $32.
    answers: { filing_status: "single", allowances: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: {
      ME_ANNUAL_WAGES: "52000", ME_STANDARD_DEDUCTION: "12850", ME_TAXABLE: "28550", ME_ANNUAL_TAX: "1667",
    },
    expectedTax: "32",
  },
  {
    state: "ME", year: 2026, label: "Example 3 — $4,500 weekly, married, 2 allowances: $256",
    citation: "Maine 2026 Withholding Tables, Example 3",
    // Standard deduction phases to $28,550 × $120,550 / $150,000 = $22,945; $13,292 ÷ 52 = $255.62 → $256.
    answers: { filing_status: "married", allowances: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "4500.00" },
    expectedFactors: {
      ME_ANNUAL_WAGES: "234000", ME_STANDARD_DEDUCTION: "22945", ME_TAXABLE: "200455", ME_ANNUAL_TAX: "13292",
    },
    expectedTax: "256",
  },
  {
    state: "ME", year: 2026, label: "W-4ME extra $5 is added: $37",
    citation: "Maine 2026 Withholding Tables, Example 2; W-4ME additional withholding",
    answers: { filing_status: "single", allowances: "2", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "37",
  },
  {
    state: "ME", year: 2026, label: "an exempt W-4ME withholds nothing",
    citation: "Maine W-4ME, exemption claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "0",
  },
  // MINNESOTA — 2026 Minnesota Withholding Tax Instructions and Tables, Computer Formula (no printed worked example; figures are the p. 34 chart's own arithmetic)
  {
    state: "MN", year: 2026, label: "weekly $1,000, single, 1 allowance: $45.63",
    citation: "2026 MN Withholding Tax Instructions, Computer Formula p. 34, Steps 2–6",
    // $52,000 − $5,300 = $46,700; $1,782.09 + 6.80% × ($46,700 − $38,010) = $2,373.01; ÷ 52.
    answers: { marital_status: "single", allowances: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { MN_ANNUAL_WAGES: "52000", MN_ANNUAL_ALLOWANCE: "5300", MN_TAXABLE: "46700", MN_ANNUAL_TAX: "2373.01" },
    expectedTax: "45.63",
  },
  {
    state: "MN", year: 2026, label: "married, withhold at higher Single rate, reads the Single chart: $45.63",
    citation: "2026 Form W-4MN marital status; Computer Formula p. 34 Single chart",
    answers: { marital_status: "married_higher_single", allowances: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { MN_ANNUAL_TAX: "2373.01" },
    expectedTax: "45.63",
  },
  {
    state: "MN", year: 2026, label: "annual wages under the first 'More than' withhold nothing ($4,680)",
    citation: "2026 MN Computer Formula p. 34, Step 4 and the chart's exclusive $4,700 floor",
    answers: { marital_status: "single", allowances: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "90.00" },
    expectedFactors: { MN_TAXABLE: "4680" },
    expectedTax: "0",
  },
  {
    state: "MN", year: 2026, label: "annual wages exactly at the first 'More than' withhold nothing ($4,700)",
    citation: "2026 MN Computer Formula p. 34, Single chart: more than $4,700",
    answers: { marital_status: "single", allowances: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 1, wages: "4700.00" },
    expectedFactors: { MN_TAXABLE: "4700" },
    expectedTax: "0",
  },
  {
    state: "MN", year: 2026, label: "no W-4MN withholds single, zero allowances; a day is 1/360: daily $100 → $4.65",
    citation: "2026 Form W-4MN instructions; Computer Formula p. 34 (daily × 360)",
    // $36,000 − $4,700 = $31,300 × 5.35% = $1,674.55; ÷ 360 = $4.65 (365 would be a different cent).
    answers: null,
    input: { payDate: "2026-03-06", periodsPerYear: 360, wages: "100.00" },
    expectedFactors: { MN_ANNUAL_WAGES: "36000", MN_ANNUAL_ALLOWANCE: "0", MN_ANNUAL_TAX: "1674.55" },
    expectedTax: "4.65",
  },
  ...[260, 365].map((periodsPerYear) => ({
    state: "MN", year: 2026, label: `daily $200 annualizes by the booklet's 360 when the payroll says ${periodsPerYear}: $11.37`,
    citation: "2026 MN Computer Formula p. 34 (daily × 360)",
    // $72,000: $1,782.09 + 6.80% × $33,990 = $4,093.41; ÷ 360. By 260 → $10.51, by 365 → $11.40.
    answers: { marital_status: "single", allowances: "0" },
    input: { payDate: "2026-03-06", periodsPerYear, wages: "200.00" },
    expectedFactors: { MN_ANNUAL_WAGES: "72000", MN_ANNUAL_TAX: "4093.41" },
    expectedTax: "11.37",
  })),
  {
    state: "MN", year: 2026, label: "married chart, biweekly $2,000, 2 allowances, $25 extra after the rate: $79.94",
    citation: "2026 MN Computer Formula p. 34 Married chart; Form W-4MN line 2",
    // $52,000 − $10,600 = $41,400; 5.35% × ($41,400 − $14,700) = $1,428.45; ÷ 26 = $54.94; + $25.
    answers: { marital_status: "married", allowances: "2", additional_per_period: "25.00" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2000.00" },
    expectedFactors: { MN_TAXABLE: "41400" },
    expectedResult: { statutoryTax: "54.94", additionalWithholding: "25" },
    expectedTax: "79.94",
  },
  {
    state: "MN", year: 2026, label: "W-4MN Section 2 exempt withholds nothing",
    citation: "2026 Form W-4MN Section 2",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    expectedTax: "0",
  },
  {
    state: "MN", year: 2026, label: "Method 1 aggregates a supplemental paid with wages",
    citation: "2026 MN Withholding Tax Instructions p. 7 Method 1; Computer Formula p. 34",
    // ($1,000 + $4,000) × 52 = $260,000; $14,315.27 + 9.85% × ($260,000 − $207,850) = $19,452.05; ÷ 52.
    answers: { marital_status: "single" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", supplemental: "4000.00" },
    expectedFactors: { MN_ANNUAL_WAGES: "260000", MN_ANNUAL_TAX: "19452.05" },
    expectedTax: "374.08",
  },
  {
    state: "MN", year: 2026, label: "nonresident expected Minnesota pay under $15,300 withholds nothing",
    citation: "2026 MN Withholding Tax Instructions p. 4",
    // $269.23 × 52 = $13,999.96 of Minnesota-source wages.
    answers: { marital_status: "single", allowances: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      wageAllocations: [{
        region: "MN", subRegion: null, workShare: "0.26923", source: "approved_time_entries",
        sourceWagesCurrentPeriod: "269.23", sourceWagesYearToDate: "0", periodsYearToDate: 1,
      }],
    },
    expectedTax: "0",
  },

  // MISSOURI — 2026 Withholding Tax Formula
  {
    state: "MO", year: 2026, label: "formula example — $35,000 annual, married spouse works: $59 monthly",
    citation: "Missouri DOR 2026 Withholding Tax Formula, worked example",
    // $35,000.04 − $16,100 = $18,900.04; $263 + $9,464.04 × 4.7% = $707.81; ÷ 12.
    answers: { filing_status: "married_spouse_works" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67" },
    expectedFactors: { MO_STANDARD_DEDUCTION: "16100", MO_ANNUAL_TAX: "707.81" },
    expectedTax: "59",
  },
  // Single carries the same $16,100 deduction and the one annual table, so it prices as the example.
  ...[{ label: "no MO W-4 withholds at the single rate", answers: null }, { label: "single", answers: { filing_status: "single" } }].map(({ label, answers }) => ({
    state: "MO", year: 2026, label: `${label}: $59 monthly`,
    citation: "Missouri DOR 2026 Withholding Tax Formula, Step 1 (single $16,100)",
    answers, input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67" },
    expectedFactors: { MO_STANDARD_DEDUCTION: "16100" }, expectedTax: "59",
  })),
  {
    state: "MO", year: 2026, label: "MO W-4 Line 3 reduced withholding replaces the formula and Line 2 extra",
    citation: "Missouri Form MO W-4 Line 3",
    answers: { filing_status: "married_spouse_works", additional_per_period: "5.00", reduced_withholding_per_period: "20.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67" },
    expectedFactors: { MO_REDUCED_WITHHOLDING: "20" },
    expectedTax: "20",
  },
  {
    state: "MO", year: 2026, label: "Line 2 extra withholding is added: $59 + $10",
    citation: "Missouri Form MO W-4 Line 2; 2026 Withholding Tax Formula",
    answers: { filing_status: "married_spouse_works", additional_per_period: "10.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67" },
    expectedTax: "69",
  },
  {
    state: "MO", year: 2026, label: "formula plus Line 2 rounds to the nearest dollar: $59 + $10.75 → $70",
    citation: "Missouri DOR 2026 Withholding Tax Formula, rounding to whole dollars",
    answers: { filing_status: "married_spouse_works", additional_per_period: "10.75" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67" },
    expectedTax: "70",
  },
  {
    state: "MO", year: 2026, label: "exempt withholds nothing",
    citation: "Missouri Form MO W-4 exemption",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67" },
    expectedTax: "0",
  },

  // MISSISSIPPI — Pub. 89-700-25-1 (Rev. 07/25), Computer Payroll Accounting flowchart (Rev. 8/13/25), Weekly 2026 Tables A/C
  {
    state: "MS", year: 2026, label: "Weekly Table A — $500, Single, $0 exemption: $11",
    citation: "Mississippi Weekly 2026 Table A cell $500–$510; Computer Payroll flowchart",
    // $26,000 − $2,300 = $23,700; 4% of $13,700 = $548; ÷ 52 = $10.54 → $11.
    answers: { filing_status: "single", exemption: "0" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedFactors: { MS_ANNUAL_WAGES: "26000", MS_STANDARD_DEDUCTION: "2300", MS_EXEMPTION: "0", MS_TAXABLE: "23700", MS_ANNUAL_TAX: "548" },
    expectedTax: "11",
  },
  {
    state: "MS", year: 2026, label: "Weekly Table A — $500, Single, $6,000 exemption: $6",
    citation: "Mississippi Weekly 2026 Table A cell $500–$510; Computer Payroll flowchart",
    // $26,000 − $6,000 − $2,300 = $17,700; 4% of $7,700 = $308; ÷ 52 = $5.92 → $6.
    answers: { filing_status: "single", exemption: "6000" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedFactors: { MS_TAXABLE: "17700", MS_ANNUAL_TAX: "308" },
    expectedTax: "6",
  },
  {
    state: "MS", year: 2026, label: "Weekly Table C — $500, married one-spouse, $0 exemption: $9",
    citation: "Mississippi Weekly 2026 Table C cell $500–$510; Computer Payroll flowchart",
    // $26,000 − $4,600 = $21,400; 4% of $11,400 = $456; ÷ 52 = $8.77 → $9.
    answers: { filing_status: "married_one", exemption: "0" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedFactors: { MS_STANDARD_DEDUCTION: "4600", MS_TAXABLE: "21400", MS_ANNUAL_TAX: "456" },
    expectedTax: "9",
  },
  {
    state: "MS", year: 2026, label: "no 89-350 withholds as Single with zero exemption: $11",
    citation: "Mississippi Pub. 89-700-25-1; Weekly 2026 Table A cell $500–$510",
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedFactors: { MS_EXEMPTION: "0", MS_STANDARD_DEDUCTION: "2300" },
    expectedTax: "11",
  },
  {
    state: "MS", year: 2026, label: "Line 7 extra withholding is added: $11 + $5",
    citation: "Mississippi Form 89-350 Line 7; Computer Payroll flowchart",
    answers: { filing_status: "single", exemption: "0", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedTax: "16",
  },
  {
    state: "MS", year: 2026, label: "formula plus Line 7 rounds to a whole dollar: $10.54 + $5.75 → $17",
    citation: "Mississippi Computer Payroll Accounting flowchart (Rev. 8/13/25)",
    answers: { filing_status: "single", exemption: "0", additional_per_period: "5.75" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedTax: "17",
  },
  {
    state: "MS", year: 2026, label: "line 8 military-spouse exemption with every eligibility fact and document on file",
    citation: "Mississippi Form 89-350 line 8",
    answers: {
      exempt: "true", servicemember_stationed_under_orders_ms: "true", employee_present_to_accompany: "true",
      employee_domiciled_outside_ms: "true", servicemember_dd2058_on_file: "true", military_spouse_id_on_file: "true",
    },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    expectedFactors: { MS_EXEMPT: "0.0001" },
    expectedTax: "0",
  },

  // MONTANA — 2026 Employer and Information Agent Guide with Tax Tables
  {
    state: "MT", year: 2026, label: "MW-4 line 4 specified withholding replaces the wage table",
    citation: "Montana 2026 Form MW-4 line 4",
    answers: { specified_withholding_per_period: "12.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00" },
    expectedFactors: { MT_SPECIFIED_WITHHOLDING: "12" },
    expectedTax: "12",
  },
  {
    state: "MT", year: 2026, label: "Example line 2 — $2,950 bi-weekly: $114",
    citation: "Montana 2026 Employer Guide, Example line 2",
    // $86 + 0.0565 × ($2,950 − $2,446) = $114.48 → $114.
    answers: { filing_status: "single_or_both" },
    input: { payDate: "2026-03-15", periodsPerYear: 26, wages: "2950.00" },
    expectedFactors: { MT_UNROUNDED: "114.48" },
    expectedTax: "114",
  },
  {
    state: "MT", year: 2026, label: "Example 1a weekly — $475: $8",
    citation: "Montana 2026 Employer Guide, Example 1a",
    // 0.047 × ($475 − $310) = $7.76 → $8.
    answers: { filing_status: "single_or_both" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "475.00" },
    expectedFactors: { MT_UNROUNDED: "7.76" },
    expectedTax: "8",
  },
  {
    state: "MT", year: 2026, label: "Example 1b — $1,375 semi-monthly, married joint: $2",
    citation: "Montana 2026 Employer Guide, Example 1b",
    // 0.047 × ($1,375 − $1,342) = $1.55 → $2.
    answers: { filing_status: "married_joint" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00" },
    expectedFactors: { MT_UNROUNDED: "1.55" },
    expectedTax: "2",
  },
  {
    state: "MT", year: 2026, label: "Example 1c — $1,375 semi-monthly, head of household: $17",
    citation: "Montana 2026 Employer Guide, Example 1c",
    // 0.047 × ($1,375 − $1,006) = $17.34 → $17.
    answers: { filing_status: "head_household" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00" },
    expectedFactors: { MT_UNROUNDED: "17.34" },
    expectedTax: "17",
  },
  {
    state: "MT", year: 2026, label: "nonresident withholding prices only Montana-source wages: $400 weekly → $4",
    citation: "Montana 2026 Employer Guide, weekly line 1a",
    // 4.7% × ($400 − $310) = $4.23 → $4.
    answers: { filing_status: "single_or_both" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      wageAllocations: [{ region: "MT", subRegion: null, workShare: "0.4", source: "approved_time_entries", sourceWagesCurrentPeriod: "400.00" }],
    },
    expectedFactors: { MT_NONRESIDENT_SOURCE_WAGES: "400", MT_UNROUNDED: "4.23" },
    expectedTax: "4",
  },
  // The guide's $704 remainder: 4.7% × ($1,375 − $671) = $33.09 → $33; no MW-4 reads line 1a.
  ...[{ label: "no MW-4 withholds as line 1a single", answers: null }, { label: "line 1a single", answers: { filing_status: "single_or_both" } }].map(({ label, answers }) => ({
    state: "MT", year: 2026, label: `${label} — $1,375 semi-monthly: $33`,
    citation: "Montana 2026 Employer Guide, semi-monthly line 1a",
    answers, input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00" },
    expectedFactors: { MT_UNROUNDED: "33.09" }, expectedTax: "33",
  })),
  {
    state: "MT", year: 2026, label: "Line 3 extra withholding is added: $33 + $5",
    citation: "Montana 2026 Form MW-4 Line 3",
    answers: { filing_status: "single_or_both", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00" },
    expectedTax: "38",
  },
  {
    state: "MT", year: 2026, label: "formula plus Line 3 rounds UP to a whole dollar: $33 + $5.25 → $39",
    citation: "Montana 2026 Employer and Information Agent Guide, rounding instructions",
    answers: { filing_status: "single_or_both", additional_per_period: "5.25" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00" },
    expectedTax: "39",
  },
  {
    state: "MT", year: 2026, label: "exempt withholds nothing",
    citation: "Montana 2026 Form MW-4 exemption",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00" },
    expectedTax: "0",
  },

  // NORTH DAKOTA — 2026 Income Tax Withholding Rates and Instructions booklet
  {
    state: "ND", year: 2026, label: "Section 2 worksheet — $1,800 weekly Single, Annual Percentage Method Table: $13",
    citation: "North Dakota 2026 Withholding Rates and Instructions, Section 2 worksheet lines 1–3",
    // $93,600: 1.95% × ($93,600 − $57,625) = $701.51; ÷ 52 = $13.49 → $13. The booklet prints line 4
    // $734.00 / line 5 $14.00, which is the $1,800–$1,825 wage-bracket cell, not this table.
    answers: { filing_status: "single" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00" },
    expectedFactors: { ND_ANNUAL_WAGES: "93600", ND_ANNUAL_TAX: "701.51" },
    expectedTax: "13",
  },
  {
    state: "ND", year: 2026, label: "no W-4 withholds as single: $13",
    citation: "North Dakota 2026 Withholding Rates and Instructions (new hire with no W-4)",
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00" },
    expectedTax: "13",
  },
  {
    state: "ND", year: 2026, label: "pre-2020 W-4 Section 1 — $97 weekly allowance, printed $10 example",
    citation: "North Dakota 2026 Withholding Rates and Instructions, Section 1 Percentage Method",
    // $1,800 − 2 × $97 = $1,606; Table 1 Single 1.95% × ($1,606 − $1,108) = $9.71 → $10.
    answers: { filing_status: "single" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00", federalLegacyW4: { status: "single", allowances: 2 } },
    expectedFactors: { ND_W4_ALLOWANCE: "194", ND_W4_TAXABLE: "1606" },
    expectedTax: "10",
  },
  {
    state: "ND", year: 2026, label: "extra withholding is added: $13 + $5",
    citation: "North Dakota 2026 Withholding Rates and Instructions",
    answers: { filing_status: "single", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00" },
    expectedTax: "18",
  },
  {
    state: "ND", year: 2026, label: "exempt withholds nothing",
    citation: "North Dakota 2026 Withholding Rates and Instructions",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00" },
    expectedTax: "0",
  },
  {
    state: "ND", year: 2026, label: "Form NDW-M with every eligibility fact and the dependent ID attached",
    citation: "North Dakota Form NDW-M",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1800.00",
      supportingCertificates: { us_nd_ndwm: resolvedCertificate(ND_NDWM_CERTIFICATE, Object.fromEntries(
        ["employee_is_civilian_spouse", "both_domiciled_outside_nd", "servicemember_stationed_in_nd", "employee_present_solely_to_accompany", "dependent_military_id_attached"].map((key) => [key, "true"]))) },
    },
    expectedFactors: { ND_MILITARY_SPOUSE_EXEMPT: "0.0001" },
    expectedTax: "0",
  },
  {
    state: "ND", year: 2026, label: "reservation exemption prices only the off-reservation wages: $2,000 − $600 → $6",
    citation: "North Dakota withholding guideline p. 2 (tribal members living and working on a reservation)",
    // $2,000 weekly single is $17 on full wages; the $1,400 remainder withholds $6.
    answers: { filing_status: "single" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 52, wages: "2000.00", basis: "nonresident",
      supportingCertificates: { [ND_TRIBAL_CERTIFICATE.key]: resolvedCertificate(ND_TRIBAL_CERTIFICATE, { enrolled_member: "true", lives_on_reservation: "true", reservation_source_wages: "600.00" }) },
    },
    expectedTax: "6",
  },
  {
    state: "ND", year: 2026, label: "qualifying military pay is excluded",
    citation: "North Dakota withholding guideline pp. 2–3, military-pay deduction",
    answers: { filing_status: "single" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", statutoryExemptionAmounts: [{ category: "military_pay", amount: "800.00" }] },
    expectedFactors: { ND_EXEMPT_MILITARY_PAY: "800" },
    expectedTax: "0",
  },
  {
    state: "ND", year: 2026, label: "military pay stays in the base when the employee elects withholding",
    citation: "North Dakota withholding guideline pp. 2–3, military-pay deduction",
    // $800 × 52 = $41,600, under the Single table's $57,625 floor, so the same $0 as unexcluded pay.
    answers: { filing_status: "single" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", statutoryExemptionAmounts: [{ category: "military_pay", amount: "800.00" }],
      supportingCertificates: { us_nd_wage_exclusion: resolvedCertificate(ND_WAGE_EXCLUSION_CERTIFICATE, { ag_labor_sole: "false", military_voluntary_withholding: "true" }) },
    },
    expectedFactors: { ND_ANNUAL_WAGES: "41600" },
    expectedTax: "0",
  },
  {
    state: "ND", year: 2026, label: "attested solely agricultural labor is excluded",
    citation: "North Dakota withholding guideline pp. 2–3, agricultural labor",
    answers: { filing_status: "single" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
      supportingCertificates: { us_nd_wage_exclusion: resolvedCertificate(ND_WAGE_EXCLUSION_CERTIFICATE, { ag_labor_sole: "true", ag_period_wages: "800", military_voluntary_withholding: "false" }) },
    },
    expectedFactors: { ND_EXEMPT_AG_LABOR: "800" },
    expectedTax: "0",
  },

  // NEBRASKA — Circular EN (2026) Table 7 and the Weekly Wage Bracket Table (cells built from the bracket mid-point)
  {
    state: "NE", year: 2026, label: "Weekly Wage Bracket $500–$510 / Single / 0 allowances: $14.38",
    citation: "Nebraska Circular EN (2026), Weekly Wage Bracket Table; Table 7 Single",
    // Mid-point $505 × 52 = $26,260; $560.35 + 4.21% × ($26,260 − $21,810) = $747.70; ÷ 52.
    answers: { filing_status: "single", allowances: "0" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "505.00", employerEmployeeCount: 0 },
    expectedFactors: { NE_ANNUAL_WAGES: "26260", NE_ALLOWANCES: "0", NE_TAXABLE: "26260", NE_ANNUAL_TAX: "747.70" },
    expectedTax: "14.38",
  },
  {
    state: "NE", year: 2026, label: "no W-4N withholds as single with zero allowances: $14.38",
    citation: "Nebraska Circular EN (2026), Weekly Wage Bracket Table",
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "505.00", employerEmployeeCount: 0 },
    expectedFactors: { NE_ALLOWANCES: "0" },
    expectedTax: "14.38",
  },
  {
    state: "NE", year: 2026, label: "extra withholding is added: $14.38 + $5",
    citation: "Nebraska Form W-4N; Circular EN (2026)",
    answers: { filing_status: "single", allowances: "0", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "505.00", employerEmployeeCount: 0 },
    expectedTax: "19.38",
  },
  // Special procedure (more than 24 employees): an exempt claim withholds 1.5% of wages net of
  // tax-qualified deductions unless lesser withholding is documented.
  ...([
    ["exempt, 24 employees keeps the ordinary exemption", 24, "1000.00", undefined, {}, "0", {}],
    ["exempt, 0 employees withholds nothing", 0, "505.00", undefined, {}, "0", {}],
    ["exempt, 25 employees: 1.5% of $1,000", 25, "1000.00", undefined, {}, "15", { NE_SPECIAL_MINIMUM: "15" }],
    ["exempt, 25 employees, $500 tax-qualified deductions: 1.5% of $500", 25, "1000.00", "500.00", {}, "7.50", { NE_SPECIAL_MINIMUM_BASE: "500" }],
    ["exempt, 25 employees, lesser withholding documented", 25, "1000.00", undefined, { lesser_withholding_documented: "true" }, "0", {}],
  ] as const).map(([label, employerEmployeeCount, wages, taxQualifiedDeductions, extra, expectedTax, expectedFactors]) => ({
    state: "NE", year: 2026, label: `special withholding minimum — ${label}`,
    citation: "Nebraska Circular EN (2026), special withholding procedure",
    answers: { exempt: "true", ...extra },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages, employerEmployeeCount, taxQualifiedDeductions },
    expectedFactors, expectedTax,
  })),

  // NEW MEXICO — FYI-104, New Mexico Withholding Tax, REV. 11/2025, Tables 1–8 (percentage method)
  {
    state: "NM", year: 2026, label: "publication worked example — married, $1,000 weekly + $20 additional: $41.80",
    citation: "New Mexico FYI-104 (REV. 11/2025) pp. 2–3, worked example",
    // $12.77 + 4.3% × ($1,000 − $790) = $12.77 + $9.03 = $21.80; + $20.00.
    answers: { filing_status: "married", additional_per_period: "20.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00" },
    expectedFactors: { NM_WAGES: "1000", NM_TABLE_TAX: "21.80" },
    expectedResult: { taxSupplemental: "0" },
    expectedTax: "41.80",
  },
  // [label, periodsPerYear, wages, answers, expectedTax, note]; a note is the table's own arithmetic.
  ...([
    ["single $1,000 weekly", 52, "1000.00", { filing_status: "single" }, "31.86", "Table 1(a): $22.41 + 4.7% × $201 ($9.45)"],
    ["no certificate withholds from the single column", 52, "1000.00", null, "31.86", "Table 1(a)"],
    ["married at the higher single rate uses the single column", 52, "1000.00", { filing_status: "married", higher_single_rate: "true" }, "31.86", "Table 1(a)"],
    ["head of household $1,000 weekly", 52, "1000.00", { filing_status: "head_household" }, "25.11", "Table 1(c): $12.77 + 4.3% × $287 ($12.34)"],
    ["extra withholding is added", 52, "1000.00", { filing_status: "single", additional_per_period: "10.00" }, "41.86", "Table 1(a) $31.86 + $10"],
    ["exempt withholds nothing", 52, "1000.00", { exempt: "true" }, "0", "Form W-4 exempt"],
    ["single $155 weekly is the zero line's top", 52, "155.00", { filing_status: "single" }, "0", "Table 1(a): (over, not-over]"],
    ["single $261 weekly", 52, "261.00", { filing_status: "single" }, "1.59", "Table 1(a): 1.5% × $106"],
    ["married $310 weekly is the zero line's top", 52, "310.00", { filing_status: "married" }, "0", "Table 1(b)"],
    ["married $463 weekly stays on the lower line", 52, "463.00", { filing_status: "married" }, "2.30", "Table 1(b): 1.5% × $153 = $2.295, not the next line's printed $2.31"],
    ["married $464 weekly enters the upper line", 52, "464.00", { filing_status: "married" }, "2.34", "Table 1(b): $2.31 + 3.2% × $1"],
    ["semimonthly single $320 is inside the zero row despite the misprinted $304 head line", 24, "320.00", { filing_status: "single" }, "0", "Table 3(a)"],
    ["semimonthly single $335 is the zero row's top", 24, "335.00", { filing_status: "single" }, "0", "Table 3(a)"],
    ["semimonthly single $340", 24, "340.00", { filing_status: "single" }, "0.08", "Table 3(a): 1.5% × $5"],
    ["semimonthly married $650 is inside the zero row despite the misprinted $608 head line", 24, "650.00", { filing_status: "married" }, "0", "Table 3(b)"],
    ["semimonthly head $500 is inside the zero row despite the misprinted $456 head line", 24, "500.00", { filing_status: "head_household" }, "0", "Table 3(c)"],
    ["biweekly single $1,000", 26, "1000.00", { filing_status: "single" }, "19.12", "Table 2(a): $16.71 + 4.3% × $56"],
    ["biweekly married $2,000", 26, "2000.00", { filing_status: "married" }, "43.56", "Table 2(b): $25.54 + 4.3% × $419"],
    ["daily single $100 on the 260-calibrated table", 260, "100.00", { filing_status: "single" }, "1.91", "Table 8(a): $1.67 + 4.3% × $5.60"],
    ["annual single $50,000", 1, "50000.00", { filing_status: "single" }, "1562.65", "Table 7(a): $1,165.50 + 4.7% × $8,450"],
    ["monthly single $800 is over a dollar and withheld", 12, "800.00", { filing_status: "single" }, "1.94", "Table 4(a): 1.5% × $129"],
    ["weekly single $700 is not excused as de minimis (the rule is monthly only)", 52, "700.00", { filing_status: "single" }, "18.17", "Table 1(a)"],
  ] as const).map(([label, periodsPerYear, wages, answers, expectedTax, note]) => ({
    state: "NM", year: 2026, label, citation: `New Mexico FYI-104 (REV. 11/2025), ${note}`,
    answers, input: { payDate: "2026-03-15", periodsPerYear, wages }, expectedTax,
  })),
  {
    state: "NM", year: 2026, label: "monthly single $700: under a dollar a month is not withheld",
    citation: "New Mexico FYI-104 (REV. 11/2025) p. 2; Table 4(a): 1.5% × $29 = $0.44",
    answers: { filing_status: "single" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "700.00" },
    expectedFactors: { NM_DE_MINIMIS: "0.44" },
    expectedTax: "0",
  },
  {
    state: "NM", year: 2026, label: "a supplemental paid with regular wages is aggregated: $800 + $200 prices as $1,000",
    citation: "New Mexico FYI-104 (REV. 11/2025) p. 4; Table 1(a)",
    // Standing alone the $200 would take the 5.9% flat ($11.80), not the table.
    answers: { filing_status: "single" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "800.00", supplemental: "200.00" },
    expectedResult: { taxSupplemental: "0" },
    expectedTax: "31.86",
  },

  // OKLAHOMA — Packet OW-2 (Revised 11-2025), Tables 1–8
  {
    state: "OK", year: 2026, label: "Packet OW-2 sample — $1,825 semi-monthly, married, 2 allowances: $37",
    citation: "Oklahoma Tax Commission Packet OW-2 (Revised 11-2025), sample computation",
    // $1,825 − 2 × $41.67 = $1,741.66; Table 3 Married $9.10 + 4.5% × ($1,741.66 − $1,129) = $36.67 → $37.
    answers: { filing_status: "married", allowances: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00" },
    expectedFactors: { OK_ALLOWANCE: "83.34", OK_TAXABLE: "1741.66", OK_UNROUNDED: "36.67" },
    expectedTax: "37",
  },
  // Table 3 Single: $4.55 + 4.5% × ($1,825 − $565) = $61.25 → $61; a blank OK-W-4 reads it.
  ...[{ label: "blank OK-W-4 withholds as single with zero allowances", answers: null }, { label: "single, zero allowances", answers: { filing_status: "single", allowances: "0" } }].map(({ label, answers }) => ({
    state: "OK", year: 2026, label: `${label} — $1,825 semi-monthly: $61`,
    citation: "Oklahoma Packet OW-2 (Revised 11-2025), Table 3 Single",
    answers, input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00" },
    expectedFactors: { OK_ALLOWANCE: "0" }, expectedTax: "61",
  })),
  {
    state: "OK", year: 2026, label: "nonresident withholding prices only Oklahoma-source wages: $1,600 → $27",
    citation: "Oklahoma Packet OW-2 (Revised 11-2025), Table 3 Married, 2 allowances",
    answers: { filing_status: "married", allowances: "2" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 24, wages: "4000.00", basis: "nonresident",
      wageAllocations: [{ region: "OK", subRegion: null, workShare: "0.4", source: "adequate_records", sourceWagesCurrentPeriod: "1600.00" }],
    },
    expectedTax: "27",
  },
  {
    state: "OK", year: 2026, label: "extra withholding is added: $37 + $5",
    citation: "Oklahoma Form OK-W-4; Packet OW-2 sample",
    answers: { filing_status: "married", allowances: "2", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00" },
    expectedTax: "42",
  },
  {
    state: "OK", year: 2026, label: "exempt withholds nothing",
    citation: "Oklahoma Form OK-W-4 exemption",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00" },
    expectedTax: "0",
  },
  {
    state: "OK", year: 2026, label: "OK-W-4 line 8 with a complete OW-9-MSE on file",
    citation: "Oklahoma Form OK-W-4 line 8; Form OW-9-MSE",
    answers: { military_spouse_exempt: "true" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00",
      supportingCertificates: { us_ok_ow9mse: resolvedCertificate(OK_OW9MSE_CERTIFICATE, Object.fromEntries(
        ["employee_is_not_servicemember", "spouse_is_servicemember", "current_orders_assign_ok", "employee_domiciled_outside_ok", "spouses_share_tax_domicile", "latest_spouse_les_on_file", "current_military_id_on_file"].map((key) => [key, "true"]))) },
    },
    expectedFactors: { OK_MILITARY_SPOUSE_EXEMPT: "0.0001" },
    expectedTax: "0",
  },
  // 68 O.S. §2385.1 (Packet OW-2 General Information p. 2): farm pay at $900 or less monthly, non-trade
  // service below $200 quarterly, and qualifying domestic service are not employment for withholding.
  ...([
    ["farm service at $800 a month is excluded", "800.00", { service_class: "farm_service", period_qualifying_wages: "800", month_qualifying_wages: "800" }, "0", { OK_EXEMPT_SERVICE_WAGES: "800" }],
    ["non-trade service under $200 a quarter is excluded", "150.00", { service_class: "nontrade_service", period_qualifying_wages: "150", quarter_qualifying_wages: "150" }, "0", { OK_EXEMPT_SERVICE_WAGES: "150" }],
    ["qualifying domestic service is excluded", "500.00", { service_class: "domestic_service", period_qualifying_wages: "500" }, "0", { OK_EXEMPT_SERVICE_WAGES: "500" }],
    // Table 3 Single: $4.55 + 4.5% × ($950 − $565) = $21.88 → $22, with or without the attestation.
    ["farm service over $900 a month withholds as ordinary wages", "950.00", { service_class: "farm_service", period_qualifying_wages: "950", month_qualifying_wages: "950" }, "22", { OK_WAGES: "950" }],
    ["$950 of ordinary wages", "950.00", null, "22", { OK_WAGES: "950" }],
  ] as const).map(([label, wages, service, expectedTax, expectedFactors]) => ({
    state: "OK", year: 2026, label: `service-class exclusion — ${label}`,
    citation: "Oklahoma Packet OW-2 (Revised 11-2025), General Information p. 2; 68 O.S. §2385.1",
    input: {
      payDate: "2026-03-15", periodsPerYear: 24, wages,
      supportingCertificates: service ? { us_ok_service_class: resolvedCertificate(OK_SERVICE_CLASS_CERTIFICATE, service) } : undefined,
    },
    expectedFactors, expectedTax,
  })),
  // OREGON — 150-206-436 (Rev. 12-31-25)
  {
    state: "OR", year: 2026, label: "Example 1 — annual $25,000 single 0 allowances, $1,000 FIT: $1,789",
    citation: "Oregon DOR 150-206-436 (Rev. 12-31-25), Example 1",
    // Lines 1–10: 25,000 − 1,000 − 2,910 = BASE 21,090; 941 on the first 11,400;
    // 0.0875 × 9,690 = 848.375, printed $848 — the dollar-rounding pin.
    answers: { marital_status: "single", allowances: "0" },
    input: { payDate: "2026-03-13", periodsPerYear: 1, wages: "25000.00", federalIncomeTax: "1000.00" },
    expectedFactors: {
      OR_ANNUAL_WAGES: "25000", OR_FEDERAL_USED: "1000", OR_STANDARD_DEDUCTION: "2910",
      OR_BASE: "21090", OR_FROM_RATES: "1789", OR_CREDIT: "0",
    },
    expectedTax: "1789",
  },
  {
    state: "OR", year: 2026, label: "Example 2 — monthly split of Example 1's $1,789 is $149",
    citation: "Oregon DOR 150-206-436 (Rev. 12-31-25), Example 2",
    // 2,083.3333 × 12 = 24,999.9996; 83.3333 × 12 = 999.9996; less 2,910 = BASE 21,090.
    answers: { marital_status: "single", allowances: "0" },
    input: { payDate: "2026-03-31", periodsPerYear: 12, wages: "2083.3333", federalIncomeTax: "83.3333" },
    expectedFactors: { OR_BASE: "21090", OR_ANNUAL_TAX: "1789" },
    expectedTax: "149",
  },
  {
    state: "OR", year: 2026, label: "FAQ 5 — a bonus aggregates: $21,000 + $4,000 prices as Example 1",
    citation: "Oregon DOR 150-206-436 (Rev. 12-31-25), FAQ 5 and Example 1",
    answers: { marital_status: "single", allowances: "0" },
    input: {
      payDate: "2026-03-13", periodsPerYear: 1, wages: "21000.00", supplemental: "4000.00", federalIncomeTax: "1000.00",
    },
    expectedFactors: { OR_ANNUAL_WAGES: "25000" },
    expectedTax: "1789",
  },
  {
    state: "OR", year: 2026, label: "OR-W-4 extra withholding is added after the formula",
    citation: "Oregon DOR 150-206-436 (Rev. 12-31-25), Example 1; OR-W-4 line 3",
    answers: { marital_status: "single", allowances: "0", additional_per_period: "25.00" },
    input: { payDate: "2026-03-13", periodsPerYear: 1, wages: "25000.00", federalIncomeTax: "1000.00" },
    expectedTax: "1814",
  },
  {
    state: "OR", year: 2026, label: "OR-W-4 exempt withholds nothing",
    citation: "Oregon DOR OR-W-4, exempt claim",
    answers: { marital_status: "single", exempt: "true" },
    input: { payDate: "2026-03-13", periodsPerYear: 1, wages: "25000.00", federalIncomeTax: "1000.00" },
    expectedTax: "0",
  },
  {
    state: "OR", year: 2026, label: "FAQ 10 — credit above tax-from-rates withholds zero, never negative",
    citation: "Oregon DOR 150-206-436 (Rev. 12-31-25), FAQ 10",
    answers: { marital_status: "single", allowances: "10" },
    input: { payDate: "2026-03-13", periodsPerYear: 1, wages: "5000.00", federalIncomeTax: "0.00" },
    expectedTax: "0",
  },
  {
    state: "OR", year: 2026, label: "no OR-W-4 withholds 8% of the Oregon-source half of $2,000",
    citation: "Oregon HB 2119 no-form rate; 150-206-436 (Rev. 12-31-25)",
    answers: null,
    input: {
      payDate: "2026-03-13", periodsPerYear: 52, wages: "2000.00", basis: "nonresident",
      wageAllocations: [
        { region: "OR", subRegion: null, workShare: "0.5", source: "verified time records" },
        { region: "WA", subRegion: null, workShare: "0.5", source: "verified time records" },
      ],
    },
    expectedFactors: { OR_WAGES: "1000" },
    expectedTax: "80",
  },
  {
    state: "OR", year: 2026, label: "no OR-W-4 and no allocation prices the whole period at 8%",
    citation: "Oregon HB 2119 no-form rate; 150-206-436 (Rev. 12-31-25)",
    answers: null,
    input: { payDate: "2026-03-13", periodsPerYear: 52, wages: "2000.00", basis: "nonresident" },
    expectedTax: "160",
  },

  // RHODE ISLAND — 2026 Employer's Income Tax Withholding Tables
  {
    state: "RI", year: 2026, label: "booklet example — $2,195 weekly, 1 exemption: $87.57",
    citation: "Rhode Island 2026 Employer's Income Tax Withholding Tables, worked example",
    // $2,195.00 − $19.23 = $2,175.77; $59.18 + 4.75% × $597.77 ($28.39) = $87.57.
    answers: { allowances: "1" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00" },
    expectedFactors: { RI_WAGES: "2195", RI_EXEMPTION: "19.23", RI_TAXABLE: "2175.77" },
    expectedTax: "87.57",
  },
  {
    state: "RI", year: 2026, label: "no RI W-4 withholds at zero allowances",
    citation: "Rhode Island 2026 Withholding Tables, weekly table",
    // $59.18 + 4.75% × ($2,195 − $1,578) = $59.18 + $29.31.
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00" },
    expectedFactors: { RI_EXEMPTION: "0" },
    expectedTax: "88.49",
  },
  {
    state: "RI", year: 2026, label: "zero allowances on file prices as no RI W-4",
    citation: "Rhode Island 2026 Withholding Tables, weekly table",
    answers: { allowances: "0" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00" },
    expectedTax: "88.49",
  },
  {
    state: "RI", year: 2026, label: "the exemption phases out above the printed $5,592.31 weekly wage",
    citation: "Rhode Island 2026 Withholding Tables, weekly exemption phase-out",
    // $154.56 + 5.99% × ($5,592.32 − $3,586) = $154.56 + $120.18.
    answers: { allowances: "1" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "5592.32" },
    expectedFactors: { RI_EXEMPTION: "0" },
    expectedTax: "274.74",
  },
  {
    state: "RI", year: 2026, label: "RI W-4 extra withholding is added",
    citation: "Rhode Island 2026 Withholding Tables, worked example; RI W-4 line 2",
    answers: { allowances: "1", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00" },
    expectedTax: "92.57",
  },
  {
    state: "RI", year: 2026, label: "RI W-4 exempt withholds nothing",
    citation: "Rhode Island RI W-4 exempt claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00" },
    expectedTax: "0",
  },

  // SOUTH CAROLINA — WH-1603F (2026)
  {
    state: "SC", year: 2026, label: "WH-1603F example — $750 weekly, 3 allowances: $10.58",
    citation: "South Carolina DOR WH-1603F (2026), worked example",
    // $39,000 − 3 × $5,000 − 10% ($3,900) = $20,100; ($20,100 − $18,230) × 6% + $437.70 = $549.90; ÷ 52.
    answers: { allowances: "3" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00" },
    expectedFactors: {
      SC_ANNUAL_WAGES: "39000", SC_PERSONAL_ALLOWANCE: "15000", SC_STANDARD_DEDUCTION: "3900",
      SC_TAXABLE: "20100", SC_ANNUAL_TAX: "549.90",
    },
    expectedTax: "10.58",
  },
  {
    state: "SC", year: 2026, label: "no SC W-4 withholds at zero allowances, with no standard deduction",
    citation: "South Carolina DOR WH-1603F (2026), formula",
    // $437.70 + 6% × ($39,000 − $18,230) = $1,683.90; ÷ 52 = $32.38.
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00" },
    expectedFactors: { SC_STANDARD_DEDUCTION: "0", SC_PERSONAL_ALLOWANCE: "0" },
    expectedTax: "32.38",
  },
  {
    state: "SC", year: 2026, label: "zero allowances on file prices as no SC W-4",
    citation: "South Carolina DOR WH-1603F (2026), formula",
    answers: { allowances: "0" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00" },
    expectedTax: "32.38",
  },
  {
    state: "SC", year: 2026, label: "SC W-4 extra withholding is added",
    citation: "South Carolina DOR WH-1603F (2026), worked example; SC W-4 line 3",
    answers: { allowances: "3", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00" },
    expectedTax: "15.58",
  },
  {
    state: "SC", year: 2026, label: "SC W-4 exempt withholds nothing",
    citation: "South Carolina SC W-4 exempt claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00" },
    expectedTax: "0",
  },

  // UTAH — Publication 14 (Rev. 4/26 from 1 June 2026; Rev. 4/25 before), p. 11
  {
    state: "UT", year: 2026, label: "Example 1 — weekly $400, Single: $12",
    citation: "Utah Publication 14 (Rev. 4/26) p. 11, Example 1",
    // Printed lines: 1. 400  2. 18  3. 9  4. 220  5. 3  6. 6  7. 12
    answers: { filing_status: "single" },
    input: { payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 52, wages: "400.00" },
    expectedFactors: { UT_LINE2: "18", UT_BASE_ALLOWANCE: "9", UT_LINE4: "220", UT_LINE5: "3", UT_LINE6: "6" },
    expectedTax: "12",
  },
  {
    state: "UT", year: 2026, label: "head of household uses the Single column: Example 1 again, $12",
    citation: "Utah Publication 14 (Rev. 4/26) p. 12 tables footnote; p. 11 Example 1",
    answers: { filing_status: "head_household" },
    input: { payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 52, wages: "400.00" },
    expectedTax: "12",
  },
  {
    state: "UT", year: 2026, label: "Example 2 — biweekly $2,600, Single: $116",
    citation: "Utah Publication 14 (Rev. 4/26) p. 11, Example 2",
    // Printed lines: 1. 2600  2. 116  3. 19  4. 2240  5. 29  6. 0  7. 116
    answers: { filing_status: "single" },
    input: { payDate: "2026-06-12", periodStart: "2026-06-01", periodsPerYear: 26, wages: "2600.00" },
    expectedFactors: { UT_BASE_ALLOWANCE: "19", UT_LINE4: "2240", UT_LINE5: "29", UT_LINE6: "0" },
    expectedTax: "116",
  },
  {
    state: "UT", year: 2026, label: "Example 2 facts, 40% Utah-source ($1,040): $36",
    citation: "Utah Publication 14 (Rev. 4/26) p. 11, Example 2 facts, Schedule 2",
    answers: { filing_status: "single" },
    input: {
      payDate: "2026-06-12", periodStart: "2026-06-01", periodsPerYear: 26, wages: "2600.00", basis: "nonresident",
      wageAllocations: [{ region: "UT", subRegion: null, workShare: "0.4", source: "adequate_records", sourceWagesCurrentPeriod: "1040.00" }],
    },
    expectedTax: "36",
  },
  {
    state: "UT", year: 2026, label: "Example 3 — semimonthly $1,200, Married: $18",
    citation: "Utah Publication 14 (Rev. 4/26) p. 11, Example 3",
    // Printed lines: 1. 1200  2. 53  3. 40  4. 421  5. 5  6. 35  7. 18
    answers: { filing_status: "married" },
    input: { payDate: "2026-06-15", periodStart: "2026-06-01", periodsPerYear: 24, wages: "1200.00" },
    expectedFactors: { UT_LINE2: "53", UT_BASE_ALLOWANCE: "40", UT_LINE4: "421", UT_LINE5: "5", UT_LINE6: "35" },
    expectedTax: "18",
  },
  {
    state: "UT", year: 2026, label: "Example 4 — monthly $7,800, Married: $347",
    citation: "Utah Publication 14 (Rev. 4/26) p. 11, Example 4",
    // Printed lines: 1. 7800  2. 347  3. 81  4. 6242  5. 81  6. 0  7. 347
    answers: { filing_status: "married" },
    input: { payDate: "2026-06-30", periodStart: "2026-06-01", periodsPerYear: 12, wages: "7800.00" },
    expectedFactors: { UT_LINE2: "347", UT_BASE_ALLOWANCE: "81", UT_LINE4: "6242", UT_LINE5: "81", UT_LINE6: "0" },
    expectedTax: "347",
  },
  {
    state: "UT", year: 2026, label: "Example 5 — quarterly $9,000, Single: $367",
    citation: "Utah Publication 14 (Rev. 4/26) p. 11, Example 5",
    // Printed lines: 1. 9000  2. 401  3. 121  4. 6663  5. 87  6. 34  7. 367
    // 9,000 × .0445 = 400.50, printed 401 — the dollar-rounding pin.
    answers: { filing_status: "single" },
    input: { payDate: "2026-06-30", periodStart: "2026-06-01", periodsPerYear: 4, wages: "9000.00" },
    expectedFactors: { UT_LINE2: "401", UT_BASE_ALLOWANCE: "121", UT_LINE4: "6663", UT_LINE5: "87", UT_LINE6: "34" },
    expectedTax: "367",
  },
  {
    state: "UT", year: 2026, label: "Example 6 — daily $175, Married: $5",
    citation: "Utah Publication 14 (Rev. 4/26) p. 11, Example 6",
    // Printed lines: 1. 175  2. 8  3. 4  4. 103  5. 1  6. 3  7. 5
    answers: { filing_status: "married" },
    input: { payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 260, wages: "175.00" },
    expectedFactors: { UT_LINE2: "8", UT_BASE_ALLOWANCE: "4", UT_LINE4: "103", UT_LINE5: "1", UT_LINE6: "3" },
    expectedTax: "5",
  },
  {
    state: "UT", year: 2026, label: "Rev. 4/25 Example 2 — biweekly $2,600, Single: $117",
    citation: "Utah Publication 14 (Rev. 4/25) p. 11, Example 2",
    // Printed lines: 1. 2600  2. 117  3. 17  4. 2250  5. 29  6. 0  7. 117
    answers: { filing_status: "single" },
    input: { payDate: "2026-03-13", periodStart: "2026-03-01", periodsPerYear: 26, wages: "2600.00" },
    expectedFactors: { UT_LINE2: "117", UT_BASE_ALLOWANCE: "17", UT_LINE4: "2250" },
    expectedTax: "117",
  },
  {
    state: "UT", year: 2026, label: "a period starting 31 May, paid 12 June, stays on Rev. 4/25: $117",
    citation: "Utah Publication 14 (Rev. 4/26): tables apply to pay periods beginning on or after June 1, 2026",
    answers: { filing_status: "single" },
    input: { payDate: "2026-06-12", periodStart: "2026-05-31", periodsPerYear: 26, wages: "2600.00" },
    expectedTax: "117",
  },
  {
    state: "UT", year: 2026, label: "Utah W-4 exempt withholds nothing",
    citation: "Utah TC-40W-4 exempt claim",
    answers: { filing_status: "single", exempt: "true" },
    input: { payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 52, wages: "400.00" },
    expectedTax: "0",
  },

  // VIRGINIA — Income Tax Withholding Guide for Employers (Rev. 05/25), Formula Method p. 21
  {
    state: "VA", year: 2026, label: "p. 21 John — semi-monthly $2,649, five exemptions: $109.48 (printed $109.50)",
    citation: "Virginia Income Tax Withholding Guide for Employers (Rev. 05/25) p. 21, John example",
    // $63,576 − ($8,750 + 5 × $930) = $50,176; $720 + 5.75% × $33,176. The example prints the
    // dollar-rounded $1,908 (W $2,628, $109.50); the guide's formula to the cent is $1,907.62,
    // so W = $2,627.62 and $109.48. The engine follows the formula.
    answers: { personal_exemptions: "5" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00" },
    expectedFactors: {
      VA_ANNUAL_WAGES: "63576", VA_ANNUAL_EXEMPTION: "13400", VA_TAXABLE: "50176", VA_ANNUAL_TAX: "2627.62",
    },
    expectedTax: "109.48",
  },
  {
    state: "VA", year: 2026, label: "John at a 40% Virginia share: $43.79",
    citation: "Virginia PD 14-192; Withholding Guide (Rev. 05/25) p. 21, John example",
    answers: { personal_exemptions: "5" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00", basis: "nonresident",
      wageAllocations: [{ region: "VA", subRegion: null, workShare: "0.4", source: "adequate_records" }],
    },
    expectedTax: "43.79",
  },
  {
    state: "VA", year: 2026, label: "daily $100 on a 260-day payroll annualizes by the table's 300: $3.21",
    citation: "Virginia Withholding Guide (Rev. 05/25), Pay Period Conversion Table (Daily = 300)",
    // $30,000 − $8,750 = $21,250; $720 + 5.75% × $4,250 = $964.38; ÷ 300. By 260 it would be $2.82.
    input: { payDate: "2026-03-15", periodsPerYear: 260, wages: "100.00" },
    expectedFactors: { VA_ANNUAL_WAGES: "30000", VA_TAXABLE: "21250", VA_ANNUAL_TAX: "964.38" },
    expectedTax: "3.21",
  },
  {
    state: "VA", year: 2026, label: "daily $100 on a 365-day payroll annualizes by the table's 300: $3.21",
    citation: "Virginia Withholding Guide (Rev. 05/25), Pay Period Conversion Table (Daily = 300)",
    // By 365 it would be $3.67.
    input: { payDate: "2026-03-15", periodsPerYear: 365, wages: "100.00" },
    expectedFactors: { VA_ANNUAL_WAGES: "30000", VA_TAXABLE: "21250", VA_ANNUAL_TAX: "964.38" },
    expectedTax: "3.21",
  },
  {
    state: "VA", year: 2026, label: "no VA-4 withholds as if no exemptions",
    citation: "Virginia Form VA-4 instructions; Withholding Guide (Rev. 05/25) p. 21 formula",
    // $63,576 − $8,750 = $54,826; $720 + 5.75% × $37,826 ($2,174.995 → $2,175.00) = $2,895; ÷ 24.
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00" },
    expectedFactors: { VA_ANNUAL_EXEMPTION: "8750", VA_TAXABLE: "54826" },
    expectedTax: "120.63",
  },
  {
    state: "VA", year: 2026, label: "VA-4 extra withholding is added after the formula",
    citation: "Virginia Withholding Guide (Rev. 05/25) p. 21, John example; VA-4 line 2",
    answers: { personal_exemptions: "5", additional_per_period: "10.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00" },
    expectedTax: "119.48",
  },
  {
    state: "VA", year: 2026, label: "a supplemental paid with regular wages aggregates, no flat 5.75%",
    citation: "Virginia Withholding Guide (Rev. 05/25) p. 19 supplemental wages; p. 21 formula",
    // $3,649 × 24 − $13,400 = $74,176; $720 + 5.75% × $57,176 = $4,007.62; ÷ 24 = $166.98.
    answers: { personal_exemptions: "5" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00", supplemental: "1000.00" },
    expectedResult: { taxSupplemental: "0" },
    expectedTax: "166.98",
  },
  {
    state: "VA", year: 2026, label: "the same $3,649 as regular wages prices identically",
    citation: "Virginia Withholding Guide (Rev. 05/25) p. 21 formula",
    answers: { personal_exemptions: "5" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "3649.00" },
    expectedTax: "166.98",
  },
  {
    state: "VA", year: 2026, label: "VA-4 line 3 exempt withholds nothing",
    citation: "Virginia Form VA-4 line 3",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00" },
    expectedTax: "0",
  },
  {
    state: "VA", year: 2026, label: "VA-4 line 4 military spouse with every eligibility fact withholds nothing",
    citation: "Virginia Form VA-4 line 4",
    answers: {
      military_spouse_exempt: "true", servicemember_orders_on_file: "true", spouse_present_solely_to_accompany: "true",
      same_nonvirginia_domicile: "true", spousal_military_id_on_file: "true",
    },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00" },
    expectedTax: "0",
  },

  // VERMONT — GB-1210 (2026)
  {
    state: "VT", year: 2026, label: "GB-1210 example — $1,800 weekly, married, 2 allowances: $45.77",
    citation: "Vermont GB-1210 (2026), worked example",
    // 2 × $103.85 = $207.70; $1,800 − $207.70 = $1,592.30; 3.35% × ($1,592.30 − $226) = $45.77.
    answers: { filing_status: "married", allowances: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00" },
    expectedFactors: { VT_WAGES: "1800", VT_ALLOWANCE: "207.70", VT_TAXABLE: "1592.30" },
    expectedTax: "45.77",
  },
  {
    state: "VT", year: 2026, label: "missing W-4VT withholds as single with zero allowances",
    citation: "Vermont GB-1210 (2026), W-4VT not on file",
    answers: null,
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00", federalAdditionalPerPeriod: "10.00" },
    expectedFactors: { VT_ALLOWANCE: "0" },
    expectedTax: "85.13",
  },
  {
    state: "VT", year: 2026, label: "W-4VT extra withholding is added",
    citation: "Vermont GB-1210 (2026), worked example; W-4VT line 5",
    answers: { filing_status: "married", allowances: "2", additional_per_period: "5.00" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00" },
    expectedTax: "50.77",
  },
  {
    state: "VT", year: 2026, label: "W-4VT exempt withholds nothing",
    citation: "Vermont W-4VT exempt claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00" },
    expectedTax: "0",
  },

  // WISCONSIN — Publication W-166 (January 2026), pp. 25–26
  {
    state: "WI", year: 2026, label: "Example 1 — weekly $350, single, 1 exemption: $7.59",
    citation: "Wisconsin Publication W-166 (January 2026) p. 25, Example 1",
    // (b) $6,702 − 12% × ($18,200 − $17,780) = $6,651.60; (c) $11,548.40; less $400;
    // (f) 3.54% × $11,148.40 = $394.65; (g) ÷ 52.
    answers: { marital_status: "single", exemptions: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00" },
    expectedFactors: { WI_ANNUAL_GROSS: "18200", WI_DEDUCTION: "6651.60", WI_ANNUAL_NET: "11148.40", WI_ANNUAL_TAX: "394.65" },
    expectedTax: "7.59",
  },
  {
    state: "WI", year: 2026, label: "married withholding at the higher Single rate prices as Example 1",
    citation: "Wisconsin Publication W-166 (January 2026) p. 25, Example 1; WT-4 line 1",
    answers: { marital_status: "married_higher_single", exemptions: "1" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00" },
    expectedTax: "7.59",
  },
  {
    state: "WI", year: 2026, label: "Example 2 — weekly $500, single, 3 exemptions: $14.34",
    citation: "Wisconsin Publication W-166 (January 2026) p. 26, Example 2",
    // $451.70 on $12,760 + 4.65% × $6,324.40 ($294.08) = $745.78; ÷ 52.
    answers: { marital_status: "single", exemptions: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "500.00" },
    expectedFactors: { WI_DEDUCTION: "5715.60", WI_ANNUAL_NET: "19084.40", WI_ANNUAL_TAX: "745.78" },
    expectedTax: "14.34",
  },
  {
    state: "WI", year: 2026, label: "Example 3 — biweekly $1,000, married, 3 exemptions: $22.08",
    citation: "Wisconsin Publication W-166 (January 2026) p. 26, Example 3",
    // (b) $9,461 − 20% × ($26,000 − $25,727) = $9,406.40; $451.70 + 4.65% × $2,633.60 = $574.16; ÷ 26.
    answers: { marital_status: "married", exemptions: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "1000.00" },
    expectedFactors: { WI_DEDUCTION: "9406.40", WI_ANNUAL_NET: "15393.60", WI_ANNUAL_TAX: "574.16" },
    expectedTax: "22.08",
  },
  {
    state: "WI", year: 2026, label: "WT-4 line 2 extra withholding is added after the formula",
    citation: "Wisconsin Publication W-166 (January 2026) p. 25, Example 1; WT-4 line 2",
    answers: { marital_status: "single", exemptions: "1", additional_per_period: "10.00" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00" },
    expectedTax: "17.59",
  },
  {
    state: "WI", year: 2026, label: "no WT-4 is single with zero exemptions",
    citation: "Wisconsin Publication W-166 (January 2026) p. 25, Example 1 steps (a)–(c)",
    // Example 1's (c) $11,548.40 with no $400 exemption: 3.54% = $408.81; ÷ 52 = $7.86.
    answers: null,
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00" },
    expectedFactors: { WI_EXEMPTION: "0" },
    expectedTax: "7.86",
  },
  {
    state: "WI", year: 2026, label: "WT-4 exempt withholds nothing",
    citation: "Wisconsin Form WT-4 exempt claim",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00" },
    expectedTax: "0",
  },
  {
    state: "WI", year: 2026, label: "a filed WT-4A agreement replaces the formula and the WT-4 extra",
    citation: "Wisconsin Publication W-166 (January 2026) §3.B p. 8; 2026 Form WT-4A, line 3 employer instruction",
    answers: { marital_status: "single", exemptions: "1", additional_per_period: "10.00" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00",
      supportingCertificates: {
        us_wi_wt4a: resolvedCertificate(payrollCertificate("US", "us_wi_wt4a"), { agreed_per_period: "4.25" }),
      },
    },
    expectedFactors: { WI_WT4A_AGREED_WITHHOLDING: "4.25" },
    expectedTax: "4.25",
  },
  {
    state: "WI", year: 2026, label: "a nonresident expecting $1,400 for the year withholds nothing on $250",
    citation: "Wisconsin Publication W-166 (January 2026) p. 8, nonresident $1,500 threshold",
    answers: { marital_status: "single", exemptions: "1" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "250.00", basis: "nonresident",
      nonresidentExpectedAnnualWages: "1400.00", nonresidentYtdWages: "0",
    },
    expectedTax: "0",
  },
  {
    state: "WI", year: 2026, label: "a W-221 military-spouse election with every fact withholds nothing",
    citation: "Wisconsin Form W-221",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      supportingCertificates: {
        us_wi_w221: resolvedCertificate(payrollCertificate("US", "us_wi_w221"), Object.fromEntries([
          "employee_is_servicemember_spouse", "servicemember_present_under_orders", "spouse_present_solely_to_accompany",
          "spouse_resides_with_servicemember", "elected_domicile_not_wisconsin",
        ].map((key) => [key, "true"]))),
      },
    },
    expectedTax: "0",
  },

  // WEST VIRGINIA — IT-100.2A (March 2026): no worked example printed; these are labelled
  // substitutes computed from the publication's own printed table lines.
  {
    state: "WV", year: 2026, label: "two-earner weekly substitute — $800, 0 exemptions: $25",
    citation: "West Virginia IT-100.2A (March 2026), Table 1 weekly two-earner (labelled substitute)",
    // Over $577, not over $866: $15.95 + 4.22% × $223 ($9.41) = $25.36, nearest dollar $25.
    answers: { exemptions: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedFactors: { WV_TAXABLE: "800" },
    expectedTax: "25",
  },
  {
    state: "WV", year: 2026, label: "no IT-104 is two-earner, zero exemptions: $25",
    citation: "West Virginia IT-100.2A (March 2026), Table 1 weekly two-earner (labelled substitute)",
    answers: null,
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedFactors: { WV_EXEMPTION: "0" },
    expectedTax: "25",
  },
  {
    state: "WV", year: 2026, label: "IT-104 line 5 elects the one-earner schedule — $800: $23",
    citation: "West Virginia IT-100.2A (March 2026), one-earner weekly table (labelled substitute)",
    // Over $769, not over $1,154: $21.27 + 4.22% × $31 ($1.31) = $22.58 → $23.
    answers: { exemptions: "0", one_earner: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedTax: "23",
  },
  {
    state: "WV", year: 2026, label: "two exemptions on $400 weekly round only at the end: $8",
    citation: "West Virginia IT-100.2A (March 2026), Table 1 weekly two-earner (labelled substitute)",
    // $400 − 2 × $38.46 = $323.08; $3.04 + 2.81% × $179.08 = $8.07 → $8.
    answers: { exemptions: "2" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "400.00" },
    expectedFactors: { WV_EXEMPTION: "76.92", WV_TAXABLE: "323.08" },
    expectedTax: "8",
  },
  {
    state: "WV", year: 2026, label: "IT-104 extra withholding is added after dollar rounding",
    citation: "West Virginia IT-100.2A (March 2026) (labelled substitute); IT-104 line 6",
    answers: { exemptions: "0", additional_per_period: "10.00" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedTax: "35",
  },
  {
    state: "WV", year: 2026, label: "§11-21-10 low-income exclusion takes a $173.08 weekly wage to zero",
    citation: "West Virginia Code §11-21-10; IT-104 low-income exclusion ($10,000 unmarried limit)",
    answers: {
      low_income_exclusion_claim: "true", low_income_return_status: "unmarried_or_joint",
      expected_annual_federal_agi: "9000.00", expected_annual_earned_income: "9000.00",
    },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "173.08" },
    expectedTax: "0",
  },
  {
    state: "WV", year: 2026, label: "a nonresident withholds on verified WV-source wages only: $320 → $8",
    citation: "West Virginia TSD 437; IT-100.2A (March 2026) weekly two-earner",
    // $3.04 + 2.81% × ($320 − $144), rounded to dollars.
    answers: { exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [{ region: "WV", subRegion: null, workShare: "0.4", source: "adequate_records", sourceWagesCurrentPeriod: "320.00" }],
    },
    expectedFactors: { WV_SOURCE_WAGES: "320" },
    expectedTax: "8",
  },
  {
    state: "WV", year: 2026, label: "IT-104NR reciprocal exemption for a Kentucky resident with wage-only WV income",
    citation: "West Virginia Form IT-104NR (KY/MD/OH/PA/VA residents)",
    answers: { exempt: "true", resident_state: "KY", only_wv_source_income_is_wages: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident" },
    expectedTax: "0",
  },
  {
    state: "WV", year: 2026, label: "IT-104NR claim with other WV-source income withholds in full: $25",
    citation: "West Virginia Form IT-104NR; IT-100.2A (March 2026) weekly two-earner",
    answers: { exempt: "true", resident_state: "KY", only_wv_source_income_is_wages: "false" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [{ region: "WV", subRegion: null, workShare: "1", source: "adequate_records", sourceWagesCurrentPeriod: "800.00" }],
    },
    expectedTax: "25",
  },
  {
    state: "WV", year: 2026, label: "IT-104NR claim from a non-reciprocal state (NY) withholds in full: $25",
    citation: "West Virginia Form IT-104NR; IT-100.2A (March 2026) weekly two-earner",
    answers: { exempt: "true", resident_state: "NY", only_wv_source_income_is_wages: "true" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [{ region: "WV", subRegion: null, workShare: "1", source: "adequate_records", sourceWagesCurrentPeriod: "800.00" }],
    },
    expectedTax: "25",
  },
  {
    state: "WV", year: 2026, label: "IT-104NR claim on a resident withholds in full: $25",
    citation: "West Virginia Form IT-104NR; IT-100.2A (March 2026) weekly two-earner",
    answers: { exempt: "true", resident_state: "KY", only_wv_source_income_is_wages: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00" },
    expectedTax: "25",
  },
  {
    state: "WV", year: 2026, label: "IT-104NR military-spouse claim with every attestation withholds nothing",
    citation: "West Virginia Form IT-104NR, military spouse",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      supportingCertificates: {
        us_wv_it104nr: resolvedCertificate(payrollCertificate("US", "us_wv_it104nr"), Object.fromEntries([
          "servicemember_is_armed_forces_member", "servicemember_present_under_orders", "spouse_present_solely_to_accompany",
          "spouse_domiciled_outside_wv", "spousal_military_id_on_file",
        ].map((key) => [key, "true"]))),
      },
    },
    expectedTax: "0",
  },
  {
    state: "WV", year: 2026, label: "§11-21-31 mobile employee at 20 WV days withholds nothing",
    citation: "West Virginia Code §11-21-31 mobile-employee exclusion (30 days or fewer)",
    answers: { exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [
        { region: "WV", subRegion: null, workShare: "0.6", source: "approved_time_entries", serviceDaysCurrentPeriod: 3, serviceDaysYearToDate: 20, sourceWagesCurrentPeriod: "480.00", sourceWagesYearToDate: "2400.00", periodsYearToDate: 6 },
        { region: "OH", subRegion: null, workShare: "0.4", source: "approved_time_entries", serviceDaysCurrentPeriod: 2, serviceDaysYearToDate: 14, sourceWagesCurrentPeriod: "320.00", sourceWagesYearToDate: "1600.00", periodsYearToDate: 6 },
      ],
      supportingCertificates: {
        us_wv_mobile: resolvedCertificate(payrollCertificate("US", "us_wv_mobile"), { not_excluded_role: "true", residence_state_qualifies: "true" }),
      },
    },
    expectedTax: "0",
  },
  {
    state: "WV", year: 2026, label: "attested nonresident Armed Forces pay is excluded",
    citation: "West Virginia Code §11-21-71; TSD 381",
    answers: { exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [{ region: "WV", subRegion: null, workShare: "1", source: "adequate_records", sourceWagesCurrentPeriod: "800.00" }],
      statutoryExemptionAmounts: [{ category: "military_pay", amount: "800.00" }],
      supportingCertificates: {
        us_wv_military_pay: resolvedCertificate(payrollCertificate("US", "us_wv_military_pay"), { armed_forces_member: "true", guard_reserve_excepted_duty: "false" }),
      },
    },
    expectedFactors: { WV_EXEMPT_MILITARY_PAY: "800", WV_TAXABLE: "0" },
    expectedTax: "0",
  },
  {
    state: "WV", year: 2026, label: "Guard/Reserve excepted-duty military pay stays taxable: $25",
    citation: "West Virginia Code §11-21-71; TSD 381 (32 USC §502 / 10 USC §270(a) exceptions)",
    answers: { exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [{ region: "WV", subRegion: null, workShare: "1", source: "adequate_records", sourceWagesCurrentPeriod: "800.00" }],
      statutoryExemptionAmounts: [{ category: "military_pay", amount: "800.00" }],
      supportingCertificates: {
        us_wv_military_pay: resolvedCertificate(payrollCertificate("US", "us_wv_military_pay"), { armed_forces_member: "true", guard_reserve_excepted_duty: "true" }),
      },
    },
    expectedFactors: { WV_TAXABLE: "800" },
    expectedTax: "25",
  },
  {
    state: "WV", year: 2026, label: "the military-pay exclusion does not reach a resident: $25",
    citation: "West Virginia Code §11-21-71 (nonresidents only); TSD 381",
    answers: { exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
      statutoryExemptionAmounts: [{ category: "military_pay", amount: "800.00" }],
      supportingCertificates: {
        us_wv_military_pay: resolvedCertificate(payrollCertificate("US", "us_wv_military_pay"), { armed_forces_member: "true", guard_reserve_excepted_duty: "false" }),
      },
    },
    expectedFactors: { WV_TAXABLE: "800" },
    expectedTax: "25",
  },
  {
    state: "WV", year: 2026, label: "qualifying nonresident seafarer wages are excluded",
    citation: "46 USC 11108(a); West Virginia CSR §110-21-71.1.2",
    answers: { exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [{ region: "WV", subRegion: null, workShare: "1", source: "adequate_records", sourceWagesCurrentPeriod: "800.00" }],
      statutoryExemptionAmounts: [{ category: "seafarer", amount: "800.00" }],
    },
    expectedFactors: { WV_EXEMPT_SEAFARER_WAGES: "800" },
    expectedTax: "0",
  },
];

const REFUSALS: Refusal[] = [
  // CA — EDD 2026 California Withholding Schedules (DE 44)
  {
    state: "CA", label: "a pay frequency the schedules print no table for",
    input: { payDate: "2026-03-06", periodsPerYear: 13, wages: "2000" },
    refusal: /publishes withholding tables for .*there is nothing to scale/s,
  },
  {
    state: "CA", label: "a military-spouse DE 4 line 4 claim without all three statutory attestations",
    answers: { military_spouse_exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "1600.00" },
    refusal: /California military-spouse withholding exemption requires proof that .*orders.*solely.*domicile/,
  },
  {
    // DE 44 p. 18: aggregated, a monthly bonus-only $1,000 check would price $0 against the $1,575
    // low-income exemption; the 10.23% flat election ($102.30) needs classified components.
    state: "CA", label: "a separately paid bonus rather than aggregating it to zero",
    answers: { filing_status: "single_or_dual", regular_allowances: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 12, wages: "0.00", supplemental: "1000.00",
      supplementalPaymentTiming: "separate",
    },
    refusal: /separately from regular wages take the DE 44.*flat election.*timed withholding dispatch.*refused by name/,
  },
  // NY — NYS-50-T-NYS (1/26): the daily table is 260-based ($33 = $8,500 ÷ 260), with no 365-day column
  {
    state: "NY", label: "a 365-day daily payroll",
    answers: { filing_status: "single_or_hoh", nys_allowances: "2" },
    input: { payDate: "2026-03-06", periodsPerYear: 365, wages: "750.00" },
    refusal: /publishes withholding tables for .*there is nothing to scale/s,
  },
  // NY-YONKERS — NYS-50-T-Y (1/26)
  {
    state: "NY-YONKERS", label: "a resident surcharge without the state tax it is a surcharge on",
    engine: YONKERS_WITHHOLDING, certificateKey: "us_ny_it2104",
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000" },
    refusal: /the state tax must be computed first and passed in/,
  },
  {
    // NJ-WT's Rate E monthly table runs "… but not over $2,916" then "over $2,917":
    // $2,916.50 falls in no printed line, and the engine will not invent one.
    state: "NJ", label: "Rate E monthly wages in the table's one-dollar gap",
    answers: { filing_status: "single", rate_table: "E" },
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "2916.50" },
    refusal: /no New Jersey Rate Table "E" line covers taxable wages of 2916\.5000 on a monthly payroll.*confirm the bracket with the Division of Taxation/s,
  },
  {
    state: "OH", label: "a payroll with no period end date",
    answers: { total_exemptions: "1" },
    input: { payDate: "2026-08-14", periodsPerYear: 26, wages: "3000.00" },
    refusal: /keyed to the PAYROLL PERIOD END DATE, not the pay date.*Supply the period end date/s,
  },
  {
    state: "OH", label: "a period ending before the earliest transcribed table set",
    input: { payDate: "2025-09-05", periodEnd: "2025-08-31", periodsPerYear: 26, wages: "3000.00" },
    refusal: /no Ohio withholding table is loaded for a payroll period ending 2025-08-31.*carries the sets effective 2025-10-01 onwards.*Transcribe it from tax\.ohio\.gov/s,
  },
  {
    // A 260-day payroll mapped onto Detroit's 365-day column would deduct 40% too
    // little exemption every day of the year.
    state: "MI", engine: DETROIT_WITHHOLDING, label: "Detroit on a 260-day daily payroll",
    answers: { exemptions: "3" },
    input: { payDate: "2026-03-06", periodsPerYear: 260, wages: "200.00" },
    refusal: /City of Detroit income tax publishes withholding tables for .*260 periods a year.*change the pay schedule to a published frequency/s,
  },
  {
    state: "MA", label: "an M-4-MS claim without its supporting facts",
    answers: { total_exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      supportingCertificates: {
        us_ma_m4_ms: resolvedCertificate(payrollCertificate("US", "us_ma_m4_ms"), { claim_status: "qualified_domicile" }),
      },
    },
    refusal: /Massachusetts military-spouse withholding exemption requires proof that the employee is the civilian spouse of an active-duty servicemember; current military orders assign the servicemember to Massachusetts; the spouse is in Massachusetts solely to be with the servicemember; the spouse and servicemember have the same non-Massachusetts tax residence or the spouse elects that residence; a current Military Spouse ID card is on file; the servicemember's DD Form 2058 is on file; the servicemember's current Leave and Earnings Statement is on file; the servicemember's current Massachusetts military orders are on file/,
  },
  {
    state: "NC", label: "NC-4 Line 2 in fractional dollars",
    answers: { additional_per_period: "5.25" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    refusal: /NC-4 Line 2 .*decimal loses precision beyond 0 decimal places/,
  },
  {
    state: "NC", label: "NC-4 NRA without the India student or apprentice classification",
    answers: { nonresident_alien: "true", additional_per_period: "11" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident" },
    refusal: /requires confirmation whether the employee is a student or business apprentice resident of India; record the certificate fact before calculating/,
  },
  {
    state: "NC", label: "NC-4 NRA nonzero Line 2 for a resident of India",
    answers: { nonresident_alien: "true", additional_per_period: "11", india_student_or_apprentice_resident: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident" },
    refusal: /Line 2 must be \$0 for a student or business apprentice who is a resident of India; correct the certificate/,
  },
  // ALABAMA — ALDOR withholding booklet; Form A4-MS; Act 2025-334; approved-severance carve-out
  {
    state: "AL", label: "no federal income tax withheld for the period",
    answers: { exemption: "M" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00" },
    refusal: /federal income tax withheld/,
  },
  {
    state: "AL", label: "an A4-MS missing its attestations and supporting records",
    answers: { exemption: "0", dependents: "0" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00", basis: "nonresident",
      supportingCertificates: {
        us_al_a4_ms: resolvedCertificate(payrollCertificate("US", "us_al_a4_ms"), { spouse_is_active_duty_member: "true" }),
      },
    },
    refusal: /Alabama military-spouse withholding exemption requires proof that the employee is not a military servicemember; current military orders assign the servicemember to Alabama; the employee is in Alabama solely to be with the servicemember; the employee and servicemember live at the same address; the employee's domicile is outside Alabama; the employee and servicemember share the same domicile; a current military spouse identification is on file; the servicemember's DD Form 2058 is on file; a recent Leave and Earnings Statement is on file/,
  },
  {
    state: "AL", label: "a nonresident without approved work-location data",
    answers: { exemption: "0", dependents: "0" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "10000.00", basis: "nonresident" },
    refusal: /needs exactly one current-period work allocation.*refused by name/,
  },
  {
    state: "AL", label: "attested ALDOR-approved severance larger than the period's pay",
    answers: { exemption: "M", dependents: "2" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00", federalIncomeTax: "35.19",
      supportingCertificates: {
        us_al_severance_approval: resolvedCertificate(payrollCertificate("US", "us_al_severance_approval"), {
          aldor_approval_on_file: "true", approved_amount: "5000", period_severance: "1000",
        }),
      },
    },
    refusal: /attested severance exceeds this period's pay/,
  },
  // COLORADO — DR 1098 (2026); DR 1059; Wage Withholding Tax Guide (Jan. 2026)
  {
    state: "CO", label: "an unprinted 365-period daily frequency",
    input: { payDate: "2026-03-06", periodsPerYear: 365, wages: "1000.00", federalFilingStatus: "single" },
    refusal: /365 periods a year.*per-period TABLE lookup.*transcribe the state's table for this one/,
  },
  {
    state: "CO", label: "a DR 1059 missing its current-year military-spouse attestations",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      supportingCertificates: {
        us_co_dr1059: resolvedCertificate(payrollCertificate("US", "us_co_dr1059"), { spouse_is_nonresident: "true" }),
      },
    },
    refusal: /Colorado military-spouse withholding exemption requires proof that the spouse is a qualifying U.S. servicemember; the servicemember is not a Colorado resident; the spouse is in Colorado solely to be with the servicemember; the servicemember is serving in compliance with military orders; the employee will notify the employer immediately if they become a Colorado resident/,
  },
  {
    state: "CO", label: "nonresident wages without the service-day allocation",
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident" },
    refusal: /CO\/null needs exactly one current-period work allocation.*Record the work share.*refused by name/,
  },
  // CONNECTICUT — Circular CT Examples 11 and 12
  {
    state: "CT", label: "supplemental standing alone from regular wages (Example 12's recompute is not decidable)",
    answers: { withholding_code: "A" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "0", supplemental: "200.00" },
    refusal: /Example 12.*no regular wages.*Pay the supplemental with the regular wages/s,
  },
  // DISTRICT OF COLUMBIA — FR-230 / OTR Tax Notice 2022-08
  {
    state: "DC", label: "a PRIOR year it has not transcribed (2025)",
    answers: { allowances: "0" },
    input: { payDate: "2025-06-15", periodsPerYear: 52, wages: "1000" },
    refusal: /2025 District of Columbia income tax withholding tables are not available in this pack version.*update the pack.*Never extrapolate the prior year/s,
  },
  {
    state: "DC", label: "a pay frequency FR-230 prints no table for (27 periods)",
    answers: { allowances: "0" },
    input: { payDate: "2026-06-15", periodsPerYear: 27, wages: "1000" },
    refusal: /District of Columbia income tax publishes withholding tables for/,
  },
  // DELAWARE — Employer's Guide, Form W-4NR source allocation
  {
    state: "DE", label: "nonresident payroll before the Form W-4NR source allocation is captured",
    answers: { filing_status: "single" },
    input: { payDate: "2026-03-15", periodsPerYear: 12, wages: "5000.00", basis: "nonresident" },
    refusal: /Delaware nonresident withholding requires Form W-4NR source-allocation facts.*refused by name/,
  },
  // HAWAII — Booklet A section 11(b), (g); Form HW-4 (Rev. 2022)
  {
    state: "HI", label: "certified-disabled status without the Department certification on file",
    answers: { filing_status: "certified_disabled" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    refusal: /Hawaii certified-disabled withholding status requires the Department-prescribed disability certification on file/,
  },
  {
    state: "HI", label: "nonresident military-spouse status without the statutory eligibility facts",
    answers: { filing_status: "nonresident_military_spouse" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    refusal: /Hawaii military-spouse withholding exemption requires proof that the servicemember is in Hawaii solely under military or naval orders; the spouse is in Hawaii solely to be with the servicemember; the spouse and servicemember are domiciled in the same state outside Hawaii/,
  },
  // IA — IA W-4 (2026) military spouse exemption
  {
    state: "IA", label: "a military-spouse exemption without the W-4 facts and attached military ID",
    answers: { military_spouse_exempt: "true" },
    input: { payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00" },
    refusal: /Iowa military-spouse withholding exemption requires proof that .*orders.*solely.*domicile.*identification card/,
  },
  // ID — Form ID W-4 line 2 "Enter whole dollars"; July 23 2026 table operative date
  {
    state: "ID", label: "fractional dollars on ID W-4 line 2",
    answers: { filing_status: "single", additional_per_period: "5.25" },
    input: { payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00" },
    refusal: /ID W-4 Line 2 .*decimal loses precision beyond 0 decimal places/,
  },
  ...["2026-04-15", "2026-07-25"].map((payDate): Refusal => ({
    state: "ID", label: `a pre-sunset 2026 pay date (${payDate})`,
    answers: { filing_status: "single" },
    input: { payDate, periodsPerYear: 26, wages: "1212" },
    refusal: /pay dates before 2026-07-31 is not loaded.*no operative date before that is established/s,
  })),
  // MD — 2026 Maryland Employer Withholding Guide; Form MW507 / MW507M
  {
    state: "MD", label: "no MW507 county of residence — the Guide does not default 3.30%",
    answers: null,
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    refusal: /needs the MW507 county of residence/,
  },
  {
    state: "MD", label: "MW507 line 8 without the filed MW507M",
    answers: { military_spouse_exempt: "true", residence_county: "16" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00" },
    refusal: /Maryland military-spouse withholding exemption requires the filed state exemption certificate/,
  },
  {
    state: "MD", label: "MW507 line 8 with an MW507M missing the duty-station, accompany and military-ID attestations",
    answers: { military_spouse_exempt: "true", residence_county: "16" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00",
      supportingCertificates: {
        us_md_mw507m: resolvedCertificate(payrollCertificate("US", "us_md_mw507m"), {
          employee_married_to_servicemember: "true", employee_domiciled_outside_md: "true",
        }),
      },
    },
    refusal: /Maryland military-spouse withholding exemption requires proof that .*duty station.*only to be with.*military ID/,
  },
  // A pay frequency the state prints no table for is refused, never scaled.
  ...([
    ["MO", "Missouri income tax", 13, {}],
    ["MS", "Mississippi income tax", 13, {}],
    ["MT", "Montana income tax", 13, {}],
    ["ND", "North Dakota income tax", 1, {}],
    ["NE", "Nebraska income tax", 13, { employerEmployeeCount: 0 }],
    ["OK", "Oklahoma income tax", 13, {}],
    ["NM", "New Mexico withholding tax", 27, {}],
    // The daily tables are 260-calibrated: a 365-day daily payroll has no printed table.
    ["NM", "New Mexico withholding tax", 365, {}],
  ] as const).map(([state, label, periodsPerYear, extra]) => ({
    state, label: `a ${periodsPerYear}-period payroll has no printed table`,
    answers: { filing_status: "single" },
    input: { payDate: "2026-03-15", periodsPerYear, wages: "1000.00", ...extra },
    refusal: new RegExp(`${label} publishes withholding tables for .* pay periods, and this payroll runs ${periodsPerYear} periods a year.*nothing to scale: change the pay schedule to a published frequency`, "s"),
  })),
  {
    state: "MS", label: "line 8 military-spouse exemption without its eligibility facts and documents",
    answers: { exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00" },
    refusal: /Mississippi military-spouse withholding exemption requires proof that .*DD-2058.*Military Spouse ID card/,
  },
  {
    state: "ND", label: "Form NDW-M missing the duty-station, solely-to-accompany and military-ID facts",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1800.00",
      supportingCertificates: { us_nd_ndwm: resolvedCertificate(ND_NDWM_CERTIFICATE, { employee_is_civilian_spouse: "true", both_domiciled_outside_nd: "true" }) },
    },
    refusal: /North Dakota military-spouse withholding exemption requires proof that .*permanent duty station.*solely.*military ID/,
  },
  {
    state: "ND", label: "attested agricultural wages above the period's pay",
    answers: { filing_status: "single" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
      supportingCertificates: { us_nd_wage_exclusion: resolvedCertificate(ND_WAGE_EXCLUSION_CERTIFICATE, { ag_labor_sole: "true", ag_period_wages: "900", military_voluntary_withholding: "false" }) },
    },
    refusal: /North Dakota attested agricultural wages exceed this period's pay — correct the attestation before calculating/,
  },
  {
    state: "ND", label: "agricultural-labor exclusion with no attested period wages",
    answers: { filing_status: "single" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
      supportingCertificates: { us_nd_wage_exclusion: resolvedCertificate(ND_WAGE_EXCLUSION_CERTIFICATE, { ag_labor_sole: "true", military_voluntary_withholding: "false" }) },
    },
    refusal: /North Dakota agricultural-labor exclusion needs this period's qualifying wages — attest the amount before calculating/,
  },
  {
    state: "OK", label: "OK-W-4 line 8 with no OW-9-MSE on file",
    answers: { military_spouse_exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00" },
    refusal: /Oklahoma military-spouse withholding exemption requires the filed state exemption certificate/,
  },
  {
    state: "OK", label: "OK-W-4 line 8 with an OW-9-MSE missing orders, domicile, LES and ID",
    answers: { military_spouse_exempt: "true" },
    input: {
      payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00",
      supportingCertificates: { us_ok_ow9mse: resolvedCertificate(OK_OW9MSE_CERTIFICATE, { employee_is_not_servicemember: "true", spouse_is_servicemember: "true" }) },
    },
    refusal: /Oklahoma military-spouse withholding exemption requires proof that .*orders.*domicile.*same state.*Leave and Earnings Statement.*ID/,
  },
  {
    state: "OK", label: "farm-service exclusion with no attested calendar-month total",
    input: {
      payDate: "2026-03-15", periodsPerYear: 24, wages: "800.00",
      supportingCertificates: { us_ok_service_class: resolvedCertificate(OK_SERVICE_CLASS_CERTIFICATE, { service_class: "farm_service", period_qualifying_wages: "800" }) },
    },
    refusal: /Oklahoma farm-service exclusion needs the attested calendar-month total — the \$900 monthly test cannot run without it/,
  },
  // OREGON — 150-206-436 (Rev. 12-31-25)
  {
    state: "OR", label: "no federal income tax withheld supplied for the period",
    answers: { marital_status: "single", allowances: "0" },
    input: { payDate: "2026-03-13", periodsPerYear: 1, wages: "25000.00" },
    refusal: /requires this period's federal income tax/,
  },
  {
    state: "OR", label: "a pay date before the first transcribed edition",
    answers: { marital_status: "single", allowances: "0" },
    input: { payDate: "2025-12-31", periodsPerYear: 1, wages: "25000.00", federalIncomeTax: "1000.00" },
    refusal: /2025 Oregon income tax withholding tables are not available in this pack version.*update the pack/s,
  },

  // RHODE ISLAND — 2026 Employer's Income Tax Withholding Tables
  {
    state: "RI", label: "allowances above the RI W-4 maximum of 10 (line 1E)",
    answers: { allowances: "11" },
    input: { payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00" },
    refusal: /RI W-4 .*allowances: 11 is above the declared maximum 10/,
  },
  {
    state: "RI", label: "a pay frequency the booklet prints no table for",
    answers: { allowances: "1" },
    input: { payDate: "2026-03-15", periodsPerYear: 13, wages: "2195" },
    refusal: /publishes withholding tables/,
  },

  // UTAH — Publication 14
  {
    state: "UT", label: "no payroll period start — the edition cut is never inferred from the pay date",
    answers: { filing_status: "single" },
    input: { payDate: "2026-06-12", periodsPerYear: 26, wages: "2600.00" },
    refusal: /keyed to the PAYROLL PERIOD START DATE, not the pay date/s,
  },
  {
    state: "UT", label: "a pay frequency with no printed schedule (13 periods)",
    input: { payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 13, wages: "2000" },
    refusal: /publishes withholding tables for .*there is nothing to scale/s,
  },
  {
    state: "UT", label: "a 365-day daily payroll against the 260-calibrated daily schedule",
    input: { payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 365, wages: "175.00" },
    refusal: /publishes withholding tables for .*there is nothing to scale/s,
  },

  // VIRGINIA — Form VA-4
  {
    state: "VA", label: "a VA-4 line 4 military-spouse claim without its eligibility evidence",
    answers: { military_spouse_exempt: "true" },
    input: { payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00" },
    refusal: /Virginia military-spouse withholding exemption requires proof that the servicemember's current Virginia military orders are on file; the spouse is present in Virginia solely to be with the servicemember; the spouse and servicemember maintain the same domicile outside Virginia; a copy of the spousal military identification card is attached/,
  },

  // VERMONT — GB-1210 (2026)
  {
    state: "VT", label: "a pay frequency GB-1210 prints no table for",
    answers: { filing_status: "married", allowances: "2" },
    input: { payDate: "2026-03-15", periodsPerYear: 13, wages: "1800" },
    refusal: /publishes withholding tables/,
  },

  // WISCONSIN — Form W-221
  {
    state: "WI", label: "a W-221 military-spouse election missing its eligibility facts",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      supportingCertificates: {
        us_wi_w221: resolvedCertificate(payrollCertificate("US", "us_wi_w221"), { employee_is_servicemember_spouse: "true" }),
      },
    },
    refusal: /Wisconsin military-spouse withholding exemption requires proof that the servicemember is present in Wisconsin in compliance with military orders; the spouse is in Wisconsin solely to be with the servicemember; the spouse resides with the servicemember; the spouse elected a qualifying domicile that is not Wisconsin/,
  },

  // WEST VIRGINIA — IT-100.2A (March 2026), IT-104NR, TSD 381 / 437
  {
    state: "WV", label: "a nonresident with no verified West Virginia work allocation",
    answers: { exemptions: "0" },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident" },
    refusal: /WV\/null needs exactly one current-period work allocation.*refused by name/s,
  },
  {
    state: "WV", label: "a quarterly payroll IT-100.2A prints no table for",
    input: { payDate: "2026-03-06", periodsPerYear: 4, wages: "20000" },
    refusal: /West Virginia income tax publishes withholding tables for/,
  },
  {
    state: "WV", label: "a 365-day daily payroll against the 260-calibrated daily table",
    input: { payDate: "2026-03-06", periodsPerYear: 365, wages: "100.00" },
    refusal: /West Virginia income tax publishes withholding tables for/,
  },
  {
    state: "WV", label: "an IT-104NR military-spouse claim missing its attestations",
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      supportingCertificates: {
        us_wv_it104nr: resolvedCertificate(payrollCertificate("US", "us_wv_it104nr"), { servicemember_is_armed_forces_member: "true" }),
      },
    },
    refusal: /West Virginia military-spouse withholding exemption requires proof that the servicemember is present in West Virginia in compliance with military orders; the employee is present in West Virginia solely to be with the servicemember; the employee maintains domicile in another state; a copy of the spousal military identification card is attached/,
  },
  {
    state: "WV", label: "military pay classified with no military-pay attestation on file",
    answers: { exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [{ region: "WV", subRegion: null, workShare: "1", source: "adequate_records", sourceWagesCurrentPeriod: "800.00" }],
      statutoryExemptionAmounts: [{ category: "military_pay", amount: "800.00" }],
    },
    refusal: /military pay is classified but no military-pay attestation is on file/,
  },
  {
    state: "WV", label: "a military-pay attestation that does not certify Armed Forces membership",
    answers: { exemptions: "0" },
    input: {
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "nonresident",
      wageAllocations: [{ region: "WV", subRegion: null, workShare: "1", source: "adequate_records", sourceWagesCurrentPeriod: "800.00" }],
      statutoryExemptionAmounts: [{ category: "military_pay", amount: "800.00" }],
      supportingCertificates: {
        us_wv_military_pay: resolvedCertificate(payrollCertificate("US", "us_wv_military_pay"), { armed_forces_member: "false", guard_reserve_excepted_duty: "false" }),
      },
    },
    refusal: /does not certify Armed Forces membership/,
  },
];

for (const row of GOLDENS) {
  test(`${row.state} ${row.year} ${row.label}`, () => {
    const result = compute(row);
    const at = `${row.state} ${row.label} (${row.citation})`;
    assert.equal(result.year, row.year, at);
    for (const [factor, expected] of Object.entries(row.expectedFactors ?? {})) {
      assert.equal(result.factors[factor], money(expected), `${at}: ${factor}`);
    }
    for (const [member, expected] of Object.entries(row.expectedResult ?? {})) {
      assert.equal(result[member as keyof typeof row.expectedResult], money(expected), `${at}: ${member}`);
    }
    assert.equal(result.tax, money(row.expectedTax), `${at}: tax`);
  });
}

for (const row of REFUSALS) {
  test(`${row.state} refuses: ${row.label}`, () => {
    assert.throws(() => compute(row), row.refusal);
  });
}

test("every state engine refuses a year it has not transcribed, and never extrapolates", () => {
  for (const engine of usStateWithholdingEngines()) {
    const next = Math.max(...engine.editions.map((edition) => edition.year)) + 1;
    const periods = engine.printedPeriods == null || engine.printedPeriods.includes("biweekly") ? 26 : 12;
    assert.throws(
      () => engine.compute({
        payDate: `${next}-01-15`, periodStart: `${next}-01-01`, periodEnd: `${next}-01-14`,
        periodsPerYear: periods, wages: "2000.00", basis: "resident",
        certificate: engine.certificateKey
          ? resolvedCertificate(payrollCertificate("US", engine.certificateKey))
          : resolveCertificate({ certificate: payrollCertificate("US", "us_pa_rev419") }),
      }),
      new RegExp(`the ${next} ${engine.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} withholding tables are not available in this pack version.*update the pack`, "s"),
      engine.state,
    );
  }
});

test("CA Examples E and F — the ANNUALIZED variant, $4.13 and $7.17", () => {
  // EDD 2026 Withholding Schedules, Examples E and F. The employer-elected alternative method is
  // exposed separately and deliberately NOT wired into `compute`: it produces different cents
  // from the per-period method, and an engine switching between two methods would be unreproducible.
  for (const [example, periodsPerYear, wagesPerPeriod, annualTax, perPeriod] of [
    ["E", 24, "2400.00", "99.20", "4.13"], // 772.40 − 673.20
    ["F", 12, "4750.00", "86.00", "7.17"], // 759.20 − 673.20
  ] as const) {
    const result = caAnnualizedMethod({
      payDate: "2026-03-15", periodsPerYear, wagesPerPeriod,
      filingStatus: "married_one_income", regularAllowances: 4,
    });
    assert.equal(result.annualTax, money(annualTax), `Example ${example} annual tax`);
    assert.equal(result.perPeriod, money(perPeriod), `Example ${example} per period`);
  }
});

test("CA Tables 1 and 3 print four columns that pair up — pinned, not collapsed", () => {
  // Columns A/B and C/D are identical at every period but stored as four keys, so a year in which
  // they diverge is a data change rather than a code change; this pins the present agreement.
  for (const table of [CA_RATES_2026.lowIncomeExemption, CA_RATES_2026.standardDeduction]) {
    for (const [period, columns] of Object.entries(table)) {
      assert.equal(columns.single_dual, columns.married_0_1, `${period} A/B`);
      assert.equal(columns.married_2_plus, columns.head_household, `${period} C/D`);
    }
  }
});

test("CA Table 4 over ten allowances multiplies the ONE-allowance figure", () => {
  // The printed footnote's own example: a married taxpayer with 15 allowances on a weekly payroll
  // is credited $48.60 = 15 × $3.24, NOT 1.5 × the ten-allowance $32.37 ($48.56).
  const result = CA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "5000.00", basis: "resident",
    certificate: resolvedCertificate(payrollCertificate("US", "us_ca_de4"), {
      filing_status: "married_one_income", regular_allowances: "15",
    }),
  });
  assert.equal(result.factors.CA_CREDIT, money("48.60"));
});

test("IL printed table headers re-derive the pay-period divisors", () => {
  // IL-700-T prints no periods-per-year table, but each table header prints the per-allowance Line 2
  // subtraction, $1,000 × 4.95% = 4,950 cents ÷ periods, which proves the divisors the engine uses.
  for (const [period, periods] of Object.entries({
    daily: 365n, weekly: 52n, biweekly: 26n, semimonthly: 24n, monthly: 12n,
  })) {
    assert.equal(
      money(IL_RATES_2026.printedLine2PerPeriod[period]!),
      fromUnits(roundDiv(4950n, periods) * 100n),
      `${period} header`,
    );
  }
});

test("NYS tables: recapture bands are non-monotonic ON PURPOSE, and Method II leaves no hole", () => {
  // 6.40% → 11.44% → 7.35% in the single schedule. "Fixing" the data to be monotonic would delete
  // New York's supplemental-tax recapture.
  const single = NY_RATES_2026.nys.tables.annual.single.map((row) => Number(row.rate));
  assert.ok(single.includes(0.1144));
  assert.ok(single.indexOf(0.1144) > single.indexOf(0.064));
  assert.ok(single[single.indexOf(0.1144) + 1]! < 0.1144);
  assert.ok(NY_RATES_2026.nys.tables.annual.married.some((row) => Number(row.rate) === 0.1349));
  // The "no line covers these wages" throw must be unreachable below the Method III handoff, so a
  // transcription that drops a row fails here rather than on a pay date.
  for (const marital of ["single", "married"] as const) {
    for (const [period, table] of Object.entries(NY_RATES_2026.nys.tables)) {
      const rows = table[marital];
      assert.equal(rows[0]!.atLeast, "0", `${period}/${marital} starts at zero`);
      for (let i = 0; i + 1 < rows.length; i++) {
        assert.equal(rows[i]!.butLessThan, rows[i + 1]!.atLeast, `${period}/${marital} row ${i} leaves a hole`);
      }
    }
  }
});

test("NYC filing status reaches the tax ONLY through the allowance table", () => {
  // NYS-50-T-NYC prints a Single and a Married table that are byte-identical in all six periods, so
  // one is stored. Same allowance count gives different Table A values…
  const nyc = (wages: string, filing_status: string, nyc_allowances: string) => NYC_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages, basis: "resident",
    certificate: resolvedCertificate(payrollCertificate("US", "us_ny_it2104"), { filing_status, nyc_allowances }),
  });
  assert.notEqual(nyc("400.00", "single_or_hoh", "3").factors.NYC_ALLOWANCE, nyc("400.00", "married", "3").factors.NYC_ALLOWANCE);
  // …but identical net wages give identical tax: $400 − $96.15 + $105.75 = $409.60.
  const single = nyc("400.00", "single_or_hoh", "0");
  const married = nyc("409.60", "married", "0");
  assert.equal(single.factors.NYC_NET, married.factors.NYC_NET);
  assert.equal(single.tax, married.tax);
});

test("Yonkers Method VIII agrees with Method VII to the cent on the published examples", () => {
  // NYS-50-T-Y (1/26): the state calibrates the exact and annualized methods to match; these are the
  // Method VII Examples 1–3 figures.
  for (const [periodsPerYear, wages, tax] of [[52, "75.00", "0"], [52, "200.00", "0.81"], [24, "400.00", "1.38"]] as const) {
    assert.equal(yonkersNonresidentAnnualized({ payDate: "2026-03-06", periodsPerYear, wages }), money(tax), wages);
  }
});

test("Yonkers supplemental rate is exactly the NYS rate times the surcharge", () => {
  // 11.70% × 16.75% = 1.95975%, compared as exact rationals.
  const exact = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)] as const;
  };
  const [nys, nysScale] = exact(NY_RATES_2026.nys.supplementalRate);
  const [surcharge, surchargeScale] = exact(NY_RATES_2026.yonkers.residentSurcharge);
  const [yonkers, yonkersScale] = exact(NY_RATES_2026.yonkers.supplementalResidentRate);
  assert.equal(nys * surcharge * yonkersScale, yonkers * nysScale * surchargeScale);
});

test("PA helpers reproduce the published figures", () => {
  // PA DLI CY2026 UC EMPLOYEE withholding: 70 cents per $1,000 of TOTAL gross wages, no wage base.
  assert.equal(paUcEmployeeWithholding("2026-03-06", "1000.00"), money("0.70"));
  assert.equal(paUcEmployeeWithholding("2026-03-06", "100000.00"), money("70.00"));
  // phila.gov: any paycheck with a pay date after 30 June uses the new rates.
  for (const [payDate, basis, rate] of [
    ["2026-06-30", "resident", "0.0374"], ["2026-07-01", "resident", "0.03735"],
    ["2026-06-30", "nonresident", "0.0343"], ["2026-07-01", "nonresident", "0.03425"],
  ] as const) {
    assert.equal(philadelphiaRateFor(payDate, basis).rate, rate, `Philadelphia ${basis} ${payDate}`);
  }
  // DCED Act 32: Bethlehem resident (1.000%) working in Allentown (1.280%) is withheld at the
  // higher 1.280%; DCED Example #2, resident 1.6% beats work-location 1.3%.
  assert.equal(act32LocalEit({ compensation: "2000.00", rate: "0.0128" }), money("25.60"));
  assert.equal(act32LocalEit({ compensation: "2000.00", rate: "0.016" }), money("32.00"));
});

test("PA Local Services Tax prorates by TRUNCATION, as DCED instructs", () => {
  // DCED: "employers are required to round DOWN to the nearest one-hundredth of a dollar".
  for (const [annualAmount, periodsPerYear, expected, note] of [
    ["52", 52, "1", "DCED $52 weekly"],
    ["52", 12, "4.33", "DCED $52 monthly"],
    ["36", 52, "0.69", "DCED $36 weekly"],
    ["36", 12, "3", "DCED $36 monthly"],
    ["156", 26, "6", "Scranton's $156: the maximum is jurisdiction data, not a $52 constant"],
  ] as const) {
    assert.equal(localServicesTaxPerPeriod({ annualAmount, periodsPerYear }), money(expected), note);
  }
  // An upfront low-income exemption stops withholding; $10 or less is a lump sum, never prorated.
  assert.equal(localServicesTaxPerPeriod({ annualAmount: "52", periodsPerYear: 52, exempt: true }), money("0"));
  assert.throws(() => localServicesTaxPerPeriod({ annualAmount: "10", periodsPerYear: 52 }), /collected as a lump sum/);
});

test("PA Local Services Tax dispatches a worksite line through computeUsWithholding", () => {
  // DCED LST: a $52 biweekly worksite withholds $2.00 — through the dispatch, not the helper.
  const result = computeUsWithholding({
    levy: { level: "sub_region", region: "PA", subRegion: "421010", label: "PA EIT", basis: "nonresident", side: "work", reach: "nonresident", certificateKey: "us_pa_clgs32_6" },
    payDate: "2026-03-06", periodEnd: "2026-03-06", periodsPerYear: 26, wages: "2000.00", federalIncomeTax: "0",
    certificateFor: () => null,
    tenantRates: (rateKey): Record<string, string> | undefined => rateKey === "us_pa_local_eit" ? { nonresidentRate: "0.01" } : rateKey === "us_pa_lst" ? { annualAmount: "52" } : undefined,
  });
  assert.equal(result!.additionalLines?.find((l) => l.code === "PA-421010-LST")?.tax, money("2"));
});

test("a printed percentage converts to a rate by shifting the point, not dividing", () => {
  for (const [printed, rate] of [
    ["1.5", "0.015"], ["0.50", "0.0050"], ["11.8", "0.118"], ["2.00", "0.0200"], ["1.25 %", "0.0125"], ["100", "1.00"],
  ] as const) {
    assert.equal(pctToRate(printed), rate, printed);
  }
  assert.throws(() => pctToRate("2.9%%"), /not a percentage/);
});

test("NJ tables are continuous but for Rate E monthly, and Rate D quarterly's printed '15.000' reads as $15,000", () => {
  // NJ-WT Rate E monthly runs "… but not over $2,916" then "over $2,917"; every
  // other line of the forty tables meets the next, and each line's "of excess
  // over" is its own floor. Rate D quarterly prints its fifth "Over" as "$ 15.000".
  const holes: string[] = [];
  for (const table of ["A", "B", "C", "D", "E"] as const) {
    for (const [period, { rows, allowance }] of Object.entries(NJ_RATES_2026.tables[table])) {
      const at = `${table}/${period}`;
      assert.ok(rows.length >= 6, at);
      assert.equal(rows[0]!.over, "0", at);
      assert.equal(rows.at(-1)!.butNotOver, null, at);
      rows.slice(1).forEach((row, i) => {
        if (rows[i]!.butNotOver !== row.over) holes.push(`${at} row ${i}`);
        assert.equal(row.ofExcessOver, row.over, `${at} excess column`);
      });
      // One allowance value per period, shared by all five rate tables.
      assert.equal(allowance, NJ_RATES_2026.tables.A[period as keyof typeof NJ_RATES_2026.tables.A].allowance, at);
    }
  }
  assert.deepEqual(holes, ["E/monthly row 1"]);
  const quarterlyD = NJ_RATES_2026.tables.D.quarterly.rows;
  assert.deepEqual([quarterlyD[3]!.butNotOver, quarterlyD[4]!.over, quarterlyD[4]!.ofExcessOver], ["15000", "15000", "15000"]);
  assert.ok(compute({
    state: "NJ", answers: { filing_status: "single", rate_table: "E" },
    input: { payDate: "2026-03-06", periodsPerYear: 12, wages: "2916.00" },
  }).tax);
});

test("NJ-W4 line 3 moves a two-income joint filer up the rate tables", () => {
  const input = { payDate: "2026-03-06", periodsPerYear: 52, wages: "1400.00" };
  const chosen = compute({ state: "NJ", answers: { filing_status: "married_joint", rate_table: "E", allowances: "3" }, input });
  assert.equal(chosen.factors.NJ_RATE_TABLE, "E");
  assert.notEqual(chosen.tax, compute({ state: "NJ", answers: { filing_status: "married_joint", allowances: "3" }, input }).tax);
});

test("Ohio's printed per-period tables ARE the annual formula, divided — but for two top-band bases", () => {
  // Ohio publishes no worked example, so the five per-period tables and the
  // annualized computer formula of the same release are made to reproduce each
  // other. Divisors are pay periods, 260 (not 365) for daily. Two printed top-band
  // bases TRUNCATE where four others round up, so no single rule reproduces the
  // set; the engine computes the formula and each defect is quantified here.
  const divisors = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, daily: 260 } as const;
  const mismatches: string[] = [];
  for (const edition of OH_EDITIONS) {
    // Each band's base is the tax on everything below it.
    const [first, second, third] = edition.formula;
    assert.equal(D(mulRateCents(U(first!.upTo!), first!.rate)), money(second!.base), `${edition.effectiveFrom} band 2`);
    assert.equal(
      D(U(second!.base) + mulRateCents(U(second!.upTo!) - U(second!.over), second!.rate)), money(third!.base),
      `${edition.effectiveFrom} band 3`,
    );
    for (const [period, periods] of Object.entries(divisors)) {
      const key = period as keyof typeof divisors;
      const at = `${edition.effectiveFrom} ${period}`;
      assert.equal(edition.printedExemption[key], D(divIntCents(U(edition.exemptionPerYear), periods)).replace(/0{2}$/, ""), at);
      edition.printedTables[key].forEach((row, i) => {
        const band = edition.formula[i]!;
        assert.equal(row.rate, band.rate, `${at} row ${i} rate`);
        assert.equal(D(U(row.over)), band.over === "0" ? D(0n) : D(divIntCents(U(band.over), periods)), `${at} row ${i} floor`);
        const base = D(divIntCents(U(band.base), periods));
        if (D(U(row.base)) !== base) mismatches.push(`${at} row ${i}: printed ${row.base}, formula ${base}`);
      });
    }
  }
  assert.deepEqual(mismatches, [
    "2025-10-01 biweekly row 2: printed 102.82, formula 102.8300",
    "2026-08-01 daily row 2: printed 10.10, formula 10.1100",
  ]);
});

test("Ohio keys its tables to the PERIOD END, across the August change and across a year end", () => {
  const ohio = (payDate: string, periodEnd: string) => compute({
    state: "OH", answers: { total_exemptions: "1" },
    input: { payDate, periodEnd, periodsPerYear: 26, wages: "3000.00" },
  });
  const july = ohio("2026-08-07", "2026-07-31");
  const august = ohio("2026-08-07", "2026-08-01");
  assert.deepEqual([july.factors.OH_EDITION, august.factors.OH_EDITION], ["2025-10-01", "2026-08-01"]);
  assert.ok(U(august.tax) < U(july.tax), "the August 2026 tables withhold less");
  // December's tables, January's tax year.
  const newYear = ohio("2026-01-02", "2025-12-31");
  assert.deepEqual([newYear.factors.OH_EDITION, newYear.year], ["2025-10-01", 2026]);
});

test("Ohio's two published methods agree within a cent, and only the formula answers an unprinted frequency", () => {
  const facts = { periodEnd: "2026-08-31", periodsPerYear: 26, wages: "3000.00", exemptions: 2 };
  const gap = U(ohOptionalComputerFormula(facts).tax) - U(ohPercentageMethod(facts));
  assert.ok(gap <= U("0.01") && gap >= U("-0.01"), `gap ${gap}`);
  const quarterly = { periodEnd: "2026-08-31", periodsPerYear: 4, wages: "20000.00", exemptions: 0 };
  assert.ok(ohOptionalComputerFormula(quarterly).tax);
  assert.throws(() => ohPercentageMethod(quarterly), /Ohio prints percentage-method tables for/);
});

test("Ohio school districts: the Department's own totals, both bases, and a closed list", () => {
  // "(a) Total number of districts are 214"; "(b) … earned income only; 68 districts."
  assert.equal(new Set(OH_SCHOOL_DISTRICTS_2026.map((district) => district.code)).size, 214);
  assert.equal(OH_SCHOOL_DISTRICTS_2026.filter((district) => district.base === "earned_income").length, 68);
  for (const district of OH_SCHOOL_DISTRICTS_2026) {
    assert.match(district.code, /^\d{4}$/, district.name);
    assert.ok(U(district.rate) >= U("0.0025") && U(district.rate) <= U("0.02"), district.name);
  }
  // Loudonville-Perrysville (traditional) and Hillsdale (earned income), both 1.25%:
  // 3 × $650 of traditional base at 1.25% is $24.375 a year, $0.94 a fortnight.
  const [traditional, earned] = [ohSchoolDistrict("2026-03-06", "0303")!, ohSchoolDistrict("2026-03-06", "0302")!];
  assert.deepEqual([traditional.printedPercent, traditional.base, earned.printedPercent, earned.base],
    ["1.25", "traditional", "1.25", "earned_income"]);
  const withhold = (district: typeof traditional) => ohSchoolDistrictWithholding({
    periodEnd: "2026-08-31", periodsPerYear: 26, wages: "2000.00", exemptions: 3, district,
  });
  assert.equal(D(U(withhold(earned).tax) - U(withhold(traditional).tax)), money("0.94"));
  assert.equal(ohSchoolDistrict("2026-03-06", "9999"), null);
  assert.throws(() => ohSchoolDistrict("2026-03-06", "303"), /not an Ohio school district number/);
  assert.throws(() => ohSchoolDistrict("2027-01-15", "0303"), /2027 Ohio school district income tax rates are not loaded/);
});

test("Ohio municipal withholding: missing rate stops the run, occasional entrants at 20 or fewer days are exempt", () => {
  assert.equal(ohMunicipalWithholding({ wages: "2000.00", rate: "0.025", municipality: "COLUMBUS" }), money("50.00"));
  assert.throws(
    () => ohMunicipalWithholding({ wages: "2000.00", rate: null, municipality: "COLUMBUS" }),
    /no income tax rate has been entered for COLUMBUS \(Ohio\)/,
  );
  // R.C. 718.011(B)(1): https://codes.ohio.gov/ohio-revised-code/section-718.011
  const entrant = {
    residentOfMunicipality: false, daysInMunicipality: 20,
    principalWorkOutsideMunicipality: true, nonSmallEmployerQualifyingWages: true,
  };
  for (const [days, expected] of [[20, "0.00"], [21, "200.00"]] as const) {
    assert.equal(ohMunicipalWithholding({
      wages: "10000.00", rate: "0.02", municipality: "WESTERVILLE", entrant: { ...entrant, daysInMunicipality: days },
    }), money(expected), `${days} days`);
  }
});

test("Detroit's printed per-period exemptions are $600 a year divided, and its worked example's is $11.54", () => {
  for (const [periods, printed] of Object.entries(MI_RATES_2026.detroit.printedExemption)) {
    assert.equal(D(divIntCents(U(MI_RATES_2026.detroit.exemptionPerYear), Number(periods))), money(printed), `${periods} periods`);
  }
  assert.equal(DETROIT_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "200.00", basis: "resident",
    certificate: resolvedCertificate(payrollCertificate("US", "us_mi_5527"), { exemptions: "3" }),
  }).factors.DETROIT_EXEMPTION_PER_PERIOD, "11.54");
});

test("Michigan's city list is CLOSED, and an unentered rate or exemption refuses", () => {
  assert.equal(MI_TAXING_CITIES.length, 24);
  assert.ok(MI_TAXING_CITIES.includes("DETROIT") && MI_TAXING_CITIES.includes("HIGHLAND_PARK"));
  const city = { wages: "1000", exemptions: 0, periodsPerYear: 52 };
  for (const [args, refusal] of [
    [{ city: "ANN_ARBOR", rate: "0.01", exemptionPerYear: "600" }, /"ANN_ARBOR" is not a Michigan city that levies an income tax/],
    [{ city: "SAGINAW", rate: null, exemptionPerYear: "750" }, /no income tax rate has been entered for SAGINAW/],
    [{ city: "SAGINAW", rate: "0.015", exemptionPerYear: null }, /no annual exemption value has been entered for SAGINAW/],
  ] as const) {
    assert.throws(() => miCityWithholding({ ...city, ...args }), refusal);
  }
  // Saginaw's exemption is $750 a year, not Detroit's $600: 2 × 14.42; 971.16 × 1.5%.
  const saginaw = miCityWithholding({ ...city, city: "SAGINAW", rate: "0.015", exemptionPerYear: "750", exemptions: 2 });
  assert.equal(saginaw.factors.MI_CITY_EXEMPTION, money("28.84"));
  assert.equal(saginaw.tax, money("14.57"));
});

test("MA supplemental example — $350,000 bonus on a $948,000 salary: $24,854", () => {
  // Circular M p. 13: $350,000 + ($948,000 − $2,000 FICA − $4,400) = $1,291,600;
  // 9% × ($1,291,600 − $1,107,750) + 5% × the remainder of the bonus.
  const result = maSupplementalWithholding({
    payDate: "2026-03-15", payment: "350000.00", annualizedRegularWagesNet: "941600.00", priorSupplemental: "0",
  });
  assert.equal(result.factors.MA_SUPP_STEP4, money("1291600"));
  assert.equal(result.factors.MA_SUPP_ABOVE_THRESHOLD, money("183850"));
  assert.equal(result.tax, money("24854"));
  // Below the threshold it is a flat 5% of the payment.
  assert.equal(maSupplementalWithholding({
    payDate: "2026-03-15", payment: "5000.00", annualizedRegularWagesNet: "80000.00",
  }).tax, money("250"));
});

test("MA exemption factors and the weekly bracket table are the Circular's own arithmetic", () => {
  // The printed "claiming 1" column is "$19 × number claimed, plus $66" at n = 1.
  for (const [period, factor] of Object.entries(MA_RATES_2026.exemptionFactors)) {
    assert.equal(D(U(factor.perExemption) + U(factor.base)), money(factor.printedClaimingOne), period);
  }
  // Weekly bracket "1,110 but less than 1,120" prints $53.83 / $49.60 / $48.63 at 0/1/2
  // exemptions: the $1,115 midpoint less $2,000 ÷ 52 retirement and the EXACT annual
  // factors ÷ 52. The percentage method's rounded $85 lands at $49.58 (a row above).
  const bracket = (exemptions: number) => {
    const perPeriod = U("1115.00") - divIntCents(U("2000"), 52)
      - (exemptions > 0 ? divIntCents(U("4400") + U("1000") * BigInt(exemptions - 1), 52) : 0n);
    return D(divIntCents(mulRateCents(perPeriod * 52n, "0.05"), 52));
  };
  assert.deepEqual([0, 1, 2].map(bracket), ["53.83", "49.60", "48.63"].map(money));
});

test("MA head of household and blindness come off the TAX; a lapsed M-4-MS resumes withholding; 27 biweekly paydays", () => {
  const ma = (answers: Record<string, string>, input: Partial<RowInput> = {}) => compute({
    state: "MA", answers: { total_exemptions: "1", ...answers },
    input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", ...input },
  });
  const base = ma({});
  // "withhold $2.31 less than the amount shown in the tax column" (weekly); blind 2 × $2.12.
  assert.equal(D(U(base.tax) - U(ma({ head_of_household: "true" }).tax)), money("2.31"));
  assert.equal(D(U(base.tax) - U(ma({ blind: "true", spouse_blind: "true" }).tax)), money("4.24"));
  const resumed = ma({ total_exemptions: "0" }, {
    basis: "nonresident",
    supportingCertificates: {
      us_ma_m4_ms: resolvedCertificate(payrollCertificate("US", "us_ma_m4_ms"), { claim_status: "no_longer_qualified" }),
    },
  });
  assert.ok(U(resumed.tax) > 0n);
  // Circular M step 3: "26 OR 27 for biweekly".
  const biweekly27 = ma({}, { periodsPerYear: 27, wages: "2000.00" });
  assert.equal(biweekly27.factors.MA_PERIOD, "biweekly");
  assert.equal(biweekly27.factors.MA_EXEMPTION_FACTOR, money("169"));
});

test("GA's rate change is keyed to 11 May 2026, and Tables E and F are one schedule printed twice", () => {
  // "continue to withhold at the rate of 5.19% BEFORE the effective date … 4.99%, starting May 11, 2026".
  for (const [payDate, rate] of [["2026-01-01", "0.0519"], ["2026-05-10", "0.0519"], ["2026-05-11", "0.0499"]] as const) {
    assert.equal(gaEditionForPayDate(payDate).rate, rate, payDate);
  }
  for (const edition of GA_EDITIONS) assert.deepEqual(edition.tableE, edition.tableF, edition.effectiveFrom);
});

test("GA's marital letters pick the column the guide's NOTE says they do", () => {
  // "Married couples, both having income, should use the standard deduction
  // allowed in column (3)" — B is the SINGLE-sized deduction, not the joint one.
  const ga = (answers: Record<string, string>, periodsPerYear = 24, wages = "3000.00") => compute({
    state: "GA", answers, input: { payDate: "2026-06-15", periodsPerYear, wages },
  }).factors;
  for (const [status, deduction] of [["A", "625.00"], ["B", "625.00"], ["C", "1250.00"], ["D", "625.00"]] as const) {
    assert.equal(ga({ marital_status: status }).GA_STANDARD_DEDUCTION, deduction, status);
  }
  // June 2026 Example #2's biweekly head-of-household deduction.
  assert.equal(ga({ marital_status: "D", dependent_allowances: "2" }, 26, "935.00").GA_STANDARD_DEDUCTION, "576.92");
  // Line 7 totals lines 4 and 5: 3 × 208.33.
  const both = ga({ marital_status: "A", dependent_allowances: "1", adjustment_allowances: "2" });
  assert.equal(both.GA_ALLOWANCES, "3");
  assert.equal(both.GA_ALLOWANCE_VALUE, money("624.99"));
});

test("NC annualized method and supplemental flat rate reproduce NC-30, rounded to the dollar", () => {
  // NC-30 p. 19: $23,400 − $12,750 − $5,000 = $5,650 × .0409 = $231.09; ÷ 52 = $4.00.
  const annualized = ncAnnualizedMethod({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "450.00", schedule: "single_married_surviving", allowances: 2,
  });
  assert.equal(annualized.annualTax, money("231.09"));
  assert.equal(annualized.tax, money("4"));
  assert.equal(ncSupplementalFlat("2026-03-06", "5000.00"), money("205")); // $204.50 → $205
});

test("NC schedules: joint shares the single schedule, and an NC-4 NRA always uses it", () => {
  const schedule = (answers: Record<string, string>, basis: "resident" | "nonresident" = "resident") => compute({
    state: "NC", answers, input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis },
  }).factors.NC_SCHEDULE;
  assert.equal(schedule({ filing_status: "head_household" }), "head_household");
  assert.equal(schedule({ filing_status: "joint_or_surviving" }), "single_married_surviving");
  assert.equal(schedule({
    filing_status: "head_household", additional_per_period: "11",
    nonresident_alien: "true", india_student_or_apprentice_resident: "false",
  }, "nonresident"), "single_married_surviving");
});

test("NC's per-period standard deductions and allowance are the annual figures, divided", () => {
  // $12,750 ÷ 52 = $245.19, ÷ 26 = $490.38, ÷ 24 = $531.25, ÷ 12 = $1,062.50; $19,125 and $2,500 likewise.
  for (const [period, periods] of Object.entries({ weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 })) {
    const values = NC_RATES_2026.periods[period as keyof typeof NC_RATES_2026.periods];
    for (const schedule of ["single_married_surviving", "head_household"] as const) {
      assert.equal(
        D(divIntCents(U(NC_RATES_2026.annual.standardDeduction[schedule]), periods)),
        money(values.standardDeduction[schedule]), `${period}/${schedule}`,
      );
    }
    assert.equal(D(divIntCents(U(NC_RATES_2026.annual.allowance), periods)), money(values.allowance), `${period} allowance`);
  }
});

/** A group-C golden row by state and label prefix; a missing row fails by name. */
function usCRow(state: string, labelPrefix: string): Golden {
  const row = GOLDENS.find((golden) => golden.state === state && golden.label.startsWith(labelPrefix));
  assert.ok(row, `${state} "${labelPrefix}…": no such golden row`);
  return row;
}

function usCCompute(state: string, answers: Record<string, string> | null, input: RowInput): UsStateWithholdingResult {
  const engine = engineFor({ state });
  return engine.compute({ basis: "resident", ...input, certificate: certificateFor(engine, { answers }) });
}

test("AL, AZ, CO, CT, HI trace flags and printed decimals that are not amounts", () => {
  // The golden rows run every factor through money(); these are flags, printed percents and
  // Table E decimals, so they are asserted verbatim against the row that produces them.
  for (const [state, label, factors] of [
    ["AL", "A4-MS with every attestation", { AL_MILITARY_SPOUSE_EXEMPT: "1" }],
    ["AL", "nonresident at 30 approved service days", { AL_SAFE_HARBOR_EXEMPT: "1" }],
    ["AZ", "Form A-4 — 2.0% of $1,000.00", { AZ_PRINTED_PERCENT: "2.0", AZ_RATE: "0.020" }],
    ["AZ", "no A-4 on file", { AZ_PRINTED_PERCENT: "2.0" }],
    ["CO", "DR 1059 with every current-year attestation", { CO_MILITARY_SPOUSE_EXEMPT: "1" }],
    ["CT", "no completed CT-W4", { CT_NO_CERTIFICATE: "1" }],
    ["CT", "Circular CT Example 8 ", { CT_CREDIT: "0.10" }],
    ["CT", "Circular CT Example 9 ", { CT_CREDIT: "0.02" }],
    ["CT", "Circular CT Example 10 ", { CT_CREDIT: "0.10" }],
    ["HI", "certified-disabled status", { HI_CERTIFIED_DISABLED_NOT_SUBJECT: "1" }],
    ["HI", "nonresident military spouse", { HI_NONRESIDENT_MILITARY_SPOUSE_NOT_SUBJECT: "1" }],
  ] as const) {
    const row = usCRow(state, label);
    const result = compute(row);
    for (const [factor, expected] of Object.entries(factors)) {
      assert.equal(result.factors[factor], expected, `${state} ${row.label} (${row.citation}): ${factor}`);
    }
  }
});

test("AL and HI: no certificate withholds exactly as the documented default", () => {
  // AL: an A-4 with no answers is zero exemptions; HI: no HW-4 is single with zero allowances.
  for (const [state, empty, explicit, periodsPerYear, wages, factor] of [
    ["AL", {}, { exemption: "0", dependents: "0" }, 52, "850.00", "AL_PERSONAL_EXEMPTION"],
    ["HI", null, { filing_status: "single", allowances: "0" }, 52, "500.00", "HI_ALLOWANCES"],
  ] as const) {
    const input = { payDate: "2026-03-15", periodsPerYear, wages, ...(state === "AL" ? { federalIncomeTax: "35.19" } : {}) };
    const defaulted = usCCompute(state, empty, input);
    assert.equal(defaulted.tax, usCCompute(state, explicit, input).tax, state);
    assert.equal(defaulted.factors[factor], money("0"), state);
  }
});

test("AL, CT and DE aggregate supplemental paid with regular wages — no silent flat rate", () => {
  // Circular CT Example 11: regular pay plus the extra in one check is one payment.
  for (const [state, answers, periodsPerYear, wages, supplemental, sum, flat] of [
    ["AL", { exemption: "M", dependents: "2" }, 52, "850.00", "200.00", "1050.00", alSupplementalFlat("200.00")],
    ["CT", { withholding_code: "A" }, 52, "1000.00", "200.00", "1200.00", D(mulRateCents(U("200"), pctToRate("6.99")))],
    ["DE", { filing_status: "single", allowances: "1" }, 12, "2000.00", "500.00", "2500.00", null],
  ] as const) {
    const base = { payDate: "2026-03-15", periodsPerYear, ...(state === "AL" ? { federalIncomeTax: "35.19" } : {}) };
    const aggregated = usCCompute(state, answers, { ...base, wages, supplemental });
    const together = usCCompute(state, answers, { ...base, wages: sum });
    assert.equal(aggregated.tax, together.tax, state);
    assert.equal(aggregated.taxSupplemental, money("0"), state);
    if (flat) assert.notEqual(aggregated.tax, flat, state);
  }
});

test("AL booklet printed deductions, exemptions, dependent allowances and bracket addends", () => {
  for (const [status, gi, expected] of [
    ["S", "25999", "3000"], ["S", "26000", "2975"], ["S", "35500", "2500"], ["M", "25999", "8500"],
    ["M", "44200", "5000"], ["H", "25999", "5200"], ["MS", "12999", "4250"], ["MS", "17750", "2500"],
  ] as const) assert.equal(alStandardDeduction(status, U(gi)), U(expected), `standard deduction ${status} $${gi}`);
  for (const [status, expected] of [["0", "0"], ["S", "1500"], ["M", "3000"]] as const) {
    assert.equal(alPersonalExemption(status), U(expected), `personal exemption ${status}`);
  }
  for (const [gi, dependents, expected] of [
    ["44200", 2, "2000"], ["50000", 1, "1000"], ["50000.01", 1, "500"], ["100000.01", 1, "300"],
  ] as const) assert.equal(alDependentAllowance(U(gi), dependents), U(expected), `dependents $${gi}`);
  // M bracket: $220 + 5% × $26,370 ($1,318.50) = $1,538.50; S first $3,000 = $110.
  assert.equal(alAnnualTax("M", U("32370")), U("1538.50"));
  assert.equal(alAnnualTax("S", U("3000")), U("110"));
  assert.equal(alSupplementalFlat("200.00"), money("10"), "separately-paid supplemental at the 5% flat rate");
});

test("AL carves ALDOR-approved severance from the formula base; the separate-flat gate shares it", () => {
  // 2024 booklet p. 14: employer-requested, ALDOR-written-approval severance up to $50,000 is
  // excluded from the formula and priced as separate wages.
  const approval = resolvedCertificate(payrollCertificate("US", "us_al_severance_approval"), {
    aldor_approval_on_file: "true", approved_amount: "5000", period_severance: "1000",
  });
  const input = { payDate: "2026-03-15", periodsPerYear: 52, wages: "1850.00", federalIncomeTax: "35.19" };
  const answers = { exemption: "M", dependents: "2" };
  const carved = usCCompute("AL", answers, { ...input, supportingCertificates: { us_al_severance_approval: approval } });
  assert.notEqual(carved.tax, usCCompute("AL", answers, input).tax);
  assert.equal(carved.factors.AL_EXEMPT_SEVERANCE, money("1000"));
  assert.equal(AL_WITHHOLDING.separateFlatExclusion!({ us_al_severance_approval: approval }), money("1000"));
});

test("AR midrange lookup, dollar rounding and annual gross tax", () => {
  // Worked example: $23,054 → midrange $23,050; DFA Step 2: $100,001 and over is exact, not midrange.
  for (const [net, midrange] of [["23054", "23050"], ["23000", "23050"], ["100000", "100050"], ["100001", "100001"], ["96050", "96050"]] as const) {
    assert.equal(arMidrangeLookup(U(net), AR_RATES_2026), U(midrange), `midrange of $${net}`);
  }
  // $23,050 × 3.4% − $287.97 = $495.73 → $496; $97,815.26 → $97,850 × 3.7% − $79.90 = $3,540.55 → $3,541;
  // the Act 2 adjustment for $96,001–$96,100 is $160.00.
  assert.equal(arRoundToDollar(U("495.73")), U("496"));
  for (const [net, tax] of [["23054", "496"], ["97815.26", "3541"], ["50000", "1485"], ["96050", "3314"]] as const) {
    assert.equal(arAnnualGrossTax(U(net), AR_RATES_2026), U(tax), `gross tax on $${net}`);
  }
});

test("AZ printed percents convert by shifting the point, not dividing", () => {
  for (const [printed, rate] of [["0.5", pctToRate("0.5")], ["2.0", "0.020"], ["2.5", "0.025"], ["3.5", "0.035"]] as const) {
    assert.equal(azRateForPrintedPercent(printed), rate, printed);
  }
});

test("AZ zero-percent A-4 holds through Feb 15, then returns to the 2.0% default", () => {
  const stored = [{
    certificateKey: AZ_CERTIFICATE.key, answers: { withholding_percent: "2.0", zero_percent: "true" }, effectiveFrom: "2025-03-01",
  }];
  for (const [asOf, tax, printed] of [["2026-02-15", "0", undefined], ["2026-02-16", "20", "2.0"]] as const) {
    const result = AZ_WITHHOLDING.compute({
      payDate: asOf, periodsPerYear: 26, wages: "1000.00", basis: "resident",
      certificate: resolveCertificate({ certificate: AZ_CERTIFICATE, stored, asOf }),
    });
    assert.equal(result.tax, money(tax), asOf);
    if (printed) assert.equal(result.factors.AZ_PRINTED_PERCENT, printed, asOf);
  }
});

test("CO FAMLI splits 0.88% equally between employee and employer", () => {
  // CDLE FY 2025-26 Performance Plan + December 2025 employer brief: $5,000 × 0.44% = $22.00 each way.
  const famli = coFamliWithholding("2026-03-06", "5000.00");
  assert.equal(famli.employee, money("22.00"));
  assert.equal(famli.employer, money("22.00"));
});

test("CT TPG-211 Tables A–E printed cells", () => {
  // [code, annual salary, expected]: first ceilings, the last $1,000 step before "and up", and the next cent.
  for (const [code, salary, exemption] of [
    ["A", "24000", "12000"], ["A", "24000.01", "11000"], ["A", "35000", "1000"], ["A", "35000.01", "0"],
    ["B", "38000", "19000"], ["B", "56000", "1000"], ["B", "56000.01", "0"], ["C", "48000", "24000"],
    ["C", "71000", "1000"], ["F", "30000", "15000"], ["F", "44000", "1000"], ["D", "10000", "0"], ["D", "999999", "0"],
  ] as const) assert.equal(ctPersonalExemption(code, U(salary)), U(exemption), `Table A ${code} $${salary}`);
  // Table B: Code A $200 + 4.5% of the excess over $10,000 ($2,000 at $50,000), then + 5.5% ($4,750 at $100,000).
  for (const [code, taxable, tax] of [
    ["A", "10000", "200"], ["A", "50000", "2000"], ["A", "100000", "4750"], ["B", "16000", "320"], ["C", "20000", "400"],
  ] as const) assert.equal(ctInitialTax(code, U(taxable)), U(tax), `Table B ${code} $${taxable}`);
  for (const [code, salary, addBack] of [
    ["A", "50250", "0"], ["A", "50250.01", "25"], ["A", "72750", "225"], ["A", "72750.01", "250"],
    ["B", "78500", "0"], ["B", "114500.01", "400"], ["C", "145500.01", "500"], ["F", "56500.01", "25"],
  ] as const) assert.equal(ctPhaseOutAddBack(code, U(salary)), U(addBack), `Table C ${code} $${salary}`);
  for (const [code, salary, recapture] of [
    ["A", "105000", "0"], ["A", "105000.01", "25"], ["A", "150000", "225"], ["A", "150000.01", "250"],
    ["A", "200000.01", "340"], ["A", "345000", "2860"], ["A", "345000.01", "2950"], ["A", "540000.01", "3400"],
    ["B", "168000.01", "40"], ["B", "320000.01", "540"], ["C", "210000.01", "50"], ["C", "400000.01", "680"],
  ] as const) assert.equal(ctTaxRecapture(code, U(salary)), U(recapture), `Table D ${code} $${salary}`);
  // Table E is a printed decimal; Step 12 applies 1.00 minus it.
  for (const [code, salary, credit] of [
    ["A", "12000", "0.00"], ["A", "12000.01", "0.75"], ["A", "52000", "0.02"], ["A", "52000.01", "0.01"],
    ["A", "52500.01", "0.00"], ["D", "20000", "0.00"], ["F", "15000.01", "0.75"], ["B", "19000.01", "0.75"],
  ] as const) assert.equal(ctPersonalCredit(code, U(salary)), credit, `Table E ${code} $${salary}`);
});

test("CT a filed 60% CT-W4NA prices only the Connecticut share of Example 8's $700", () => {
  // Circular CT Example 8: $420 × 52 annualizes to $21,840 instead of $36,400.
  const allocated = usCCompute("CT", { withholding_code: "F" }, {
    payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00", basis: "nonresident",
    supportingCertificates: {
      us_ct_ctw4na: resolvedCertificate(payrollCertificate("US", "us_ct_ctw4na"), { allocation_percentage: "60" }),
    },
  });
  assert.equal(allocated.factors.CT_ANNUAL_WAGES, money("21840"));
});

test("CT Paid Leave withholds 0.5% of FICA wages to the Social Security base", () => {
  // $1,000 × 0.5% = $5.00, capped at the $184,500 Social Security taxable maximum.
  assert.equal(ctPaidLeaveWithholding("2026-03-06", "1000.00", "0"), money("5.00"));
  assert.equal(ctPaidLeaveWithholding("2026-03-06", "1000.00", "184500"), money("0.00"));
});

test("DC 2026 schedule: each cumulative base is the tax at its threshold", () => {
  // OTR "DC Individual and Fiduciary Income Tax Rates", tax years beginning after 12/31/2021.
  const brackets = DC_RATES_2026.brackets;
  assert.deepEqual(brackets.map((bracket) => bracket.base), ["0", "400", "2200", "3500", "19650", "42775", "91525"]);
  for (let i = 1; i < brackets.length; i++) {
    const below = brackets[i - 1]!;
    assert.equal(D(U(below.base) + mulRateCents(U(brackets[i]!.over) - U(below.over), below.rate)),
      money(brackets[i]!.base), `DC bracket ${i}`);
  }
});

test("DC allowance: the Pub 15-T (2026) $4,300, and per-period amounts are annual ÷ divisor half-up", () => {
  // Pub 15-T (2026) Worksheet 1A line 1k, the figure OTR Tax Notice 2022-08 points at. The DC module
  // carries its own copy only because importing the federal rates would close a module cycle.
  assert.equal(DC_RATES_2026.allowanceAnnual, "4300");
  assert.equal(DC_RATES_2026.allowanceAnnual, RATES_2026.allowanceAmount);
  // FR-230 Table 1 prints eight periods; 2018's printed cents (p. 9, annual $4,150) prove the scaling
  // rule, and the 2026 cents are that rule on $4,300.
  const rates2018: DcYearRates = {
    year: 2018, status: "published", allowanceAnnual: "4150",
    brackets: [
      { over: "0", notOver: "10000", base: "0", rate: pctToRate("4") },
      { over: "10000", notOver: "40000", base: "400", rate: pctToRate("6") },
      { over: "40000", notOver: "60000", base: "2200", rate: pctToRate("6.5") },
      { over: "60000", notOver: "350000", base: "3500", rate: pctToRate("8.5") },
      { over: "350000", notOver: "1000000", base: "28150", rate: pctToRate("8.75") },
      { over: "1000000", notOver: null, base: "85025", rate: pctToRate("8.95") },
    ],
  };
  for (const [period, periods, cents2018, cents2026] of [
    ["weekly", 52, "79.81", "82.69"], ["biweekly", 26, "159.62", "165.38"], ["semimonthly", 24, "172.92", "179.17"],
    ["monthly", 12, "345.83", "358.33"], ["quarterly", 4, "1037.50", "1075"], ["semiannual", 2, "2075.00", "2150"],
    ["annual", 1, "4150.00", "4300"], ["daily", 365, "11.37", "11.78"],
  ] as const) {
    for (const [rates, printed] of [[rates2018, cents2018], [DC_RATES_2026, cents2026]] as const) {
      const derived = divIntCents(U(rates.allowanceAnnual), dcDivisorForPeriod(period, periods));
      assert.equal(D(derived), money(printed), `${rates.year} ${period} is annual ÷ ${periods} half-up`);
      assert.equal(dcAllowancePerPeriod(rates, period, periods), derived, `${rates.year} ${period} helper is that division`);
    }
  }
  // Daily is 365 even when the payroll runs 260 periods — the booklet prints one daily table.
  assert.equal(dcDivisorForPeriod("daily", 260), 365);
  assert.equal(dcDivisorForPeriod("weekly", 52), 52);
  assert.equal(dcAllowancePerPeriod(DC_RATES_2026, "daily", 260), divIntCents(U(DC_RATES_2026.allowanceAnnual), 365));
  // FR-230 pp. 10–11 printed 2018 bracket cells: [scaled value, annual figure, divisor, printed].
  const weekly = dcScaledBrackets(rates2018, "weekly", 52);
  const daily = dcScaledBrackets(rates2018, "daily", 365);
  // The monthly joint/head schedule prints the same $291.67 / $5,000 for 8.5%: the schedule is status-blind.
  const monthly = dcScaledBrackets(rates2018, "monthly", 12);
  for (const [label, scaled, annual, divisor, printed] of [
    ["weekly B2 over", weekly[1]!.over, "10000", 52, "192.31"], ["weekly B2 not over", weekly[1]!.notOver!, "40000", 52, "769.23"],
    ["weekly B2 base", weekly[1]!.base, "400", 52, "7.69"], ["weekly B6 over", weekly[5]!.over, "1000000", 52, "19230.77"],
    ["weekly B6 base", weekly[5]!.base, "85025", 52, "1635.10"], ["daily B1 not over", daily[0]!.notOver!, "10000", 365, "27.40"],
    ["daily B2 over", daily[1]!.over, "10000", 365, "27.40"], ["daily B2 not over", daily[1]!.notOver!, "40000", 365, "109.59"],
    ["daily B2 base", daily[1]!.base, "400", 365, "1.10"], ["monthly B4 over", monthly[3]!.over, "60000", 12, "5000"],
    ["monthly B4 base", monthly[3]!.base, "3500", 12, "291.67"],
  ] as const) {
    assert.equal(scaled, divIntCents(U(annual), divisor), `FR-230 2018 ${label} is annual ÷ ${divisor}`);
    assert.equal(D(scaled), money(printed), `FR-230 2018 ${label} printed`);
  }
});

test("DE Tax Computation Table and Section 17's printed ÷ P lines", () => {
  assert.equal(deAnnualTax(U("60000")), U("2943.50"));
  assert.equal(deAnnualPeriods(365, DE_RATES_2026.dailyPeriods), 300);
  assert.equal(deAnnualPeriods(52, DE_RATES_2026.dailyPeriods), 52);
  // Weekly, bi-weekly, semi-monthly and monthly figures Section 17 prints for each annual example.
  for (const [status, printed] of [
    ["single", ["13.88", "27.77", "30.08", "60.17"]],
    ["married_joint", ["6.52", "13.04", "14.13", "28.25"]],
    ["married_separate", ["11.77", "23.54", "25.50", "51.00"]],
  ] as const) {
    const annual = compute(usCRow("DE", `Section 17 — ${status},`)).tax;
    [52, 26, 24, 12].forEach((periods, i) =>
      assert.equal(D(divIntCents(U(annual), periods)), money(printed[i]!), `DE Section 17 ${status} ÷ ${periods}`));
  }
});

test("HI HW-4 accepts the married-at-Single-rate status and has no generic exempt status", () => {
  assert.equal(certificateAnswersProblem(HI_CERTIFICATE, { filing_status: "married_single_rate" }), null);
  assert.equal(HI_CERTIFICATE.fields.some((field) => field.key === "exempt"), false);
});

test("a missing certificate withholds exactly as the documented default (KS K-4 and ME W-4ME: single, 0)", () => {
  // KW-100 and the Maine 2026 booklet: no certificate means single with zero allowances.
  for (const [state, periodsPerYear, wages, factor] of [
    ["KS", 24, "2000.00", "KS_ALLOWANCE"], ["ME", 52, "1000.00", "ME_ALLOWANCES"],
  ] as const) {
    const input = { payDate: "2026-03-15", periodsPerYear, wages };
    const empty = compute({ state, answers: null, input });
    assert.equal(empty.tax, compute({ state, answers: { filing_status: "single", allowances: "0" }, input }).tax, state);
    assert.equal(empty.factors[factor], money("0"), state);
  }
});

test("IN DN#1 Table A/B/C weekly constants are $1,000 / $1,500 / $3,000 ÷ 52", () => {
  // Departmental Notice #1 (R46 01-26), p. 3 worked example's deduction-constant lines.
  const none = { personal: 0, additionalDependent: 0, firstTimeDependent: 0, adoptedDependent: 0 };
  for (const [exemptions, expected] of [
    [{ personal: 5 }, "96.15"], [{ additionalDependent: 3 }, "86.54"],
    [{ firstTimeDependent: 1 }, "28.85"], [{ adoptedDependent: 2 }, "115.38"],
  ] as const) {
    const result = inPeriodTaxable({
      payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", exemptions: { ...none, ...exemptions },
    });
    assert.equal(result.factors.IN_PERIOD_EXEMPTION, money(expected), JSON.stringify(exemptions));
  }
});

test("IN DN#1 publishes all 92 county rates; unknown codes refuse and a blank county withholds nothing", () => {
  assert.equal(IN_COUNTIES_2026.length, 92);
  assert.equal(new Set(IN_COUNTIES_2026.map((c) => c.code)).size, 92);
  assert.equal(IN_COUNTIES_2026.filter((c) => c.changedSinceOct2025).length, 6);
  // High-precision rates that a rounded guess would miss, and the table's extremes.
  for (const [code, rate, name] of [
    ["07", "0.025234", "Brown"], ["08", "0.024733", "Carroll"], ["37", "0.02864", "Jasper"],
    ["92", "0.016829", "Whitley"], ["64", "0.005", "Porter (lowest)"], ["68", "0.03", "Randolph (highest)"],
  ] as const) assert.equal(inCounty(2026, code).rate, rate, name);
  assert.throws(() => inCounty(2026, "99"), /not an Indiana county code/);
  // [residence county, work county, applicable county]: residence wins; an out-of-state resident takes the work county.
  for (const [residence, work, expected] of [
    ["NA", null, null], ["not applicable", "", null], [null, null, null], ["NA", "49", "49"], ["31", "49", "31"],
  ] as const) {
    assert.equal(inApplicableCounty("2026-03-06", residence, work)?.code ?? null, expected, `${residence}/${work}`);
  }
});

test("IN county tax dispatches through computeUsWithholding — DN#1 p. 3 Harrison county figures", () => {
  // Driven through the pack dispatch, not the engine, so a missing IN branch fails here. DN#1 p. 3:
  // "County Tax to Withhold $473.08 × .01 = $4.73"; supplemental pay takes no WH-4 exemption; a
  // WH-4MIL exemption excludes county tax too, and a WH-4AFF waiver excludes county tax alone.
  const example = {
    personal_exemptions: "5", additional_dependent_exemptions: "3",
    first_time_dependent_exemptions: "1", adopted_dependent_exemptions: "2",
  };
  for (const [label, answers, supplemental, tax, factors] of [
    ["DN#1 p. 3 example", example, undefined, "4.73", { IN_COUNTY_RATE: "0.01" }],
    ["$200 supplemental, combined", example, "200.00", "6.73", { IN_COUNTY_SUPPLEMENTAL_TAXABLE: money("200.00") }],
    ["WH-4MIL exempt", { exempt: "true" }, undefined, "0", { IN_EXEMPT: "1" }],
    ["WH-4AFF county waiver", { county_exempt: "true" }, undefined, "0", {}],
  ] as const) {
    const certificate = resolvedCertificate(payrollCertificate("US", "us_in_wh4"), answers);
    const result = computeUsWithholding({
      levy: {
        level: "sub_region", region: "IN", subRegion: "31", label: "Harrison County income tax",
        basis: "resident", side: "residence", reach: "resident", certificateKey: "us_in_wh4",
      },
      payDate: "2026-03-06", periodEnd: "2026-03-06", periodsPerYear: 52, wages: "800.00",
      ...(supplemental ? { supplemental, supplementalPaymentTiming: "combined" as const } : {}),
      federalIncomeTax: "13.96", certificateFor: () => certificate, tenantRates: () => undefined,
    });
    assert.ok(result, `${label}: the county levy computes instead of refusing`);
    assert.equal(result.code, "IN-31", label);
    assert.equal(result.tax, money(tax), label);
    for (const [factor, expected] of Object.entries(factors)) assert.equal(result.factors[factor], expected, `${label}: ${factor}`);
  }
});

test("ME standard deduction phase-out endpoints from the 2026 booklet", () => {
  // Single $12,850 holds through $102,250 of annual wages and is gone by $177,250.
  for (const [wages, expected] of [["102250", "12850"], ["177250", "0"]] as const) {
    assert.equal(meStandardDeduction(U(wages), false, ME_RATES_2026), U(expected), wages);
  }
});

test("MD reciprocity is DC / VA / WV on MW507 line 4 — not Pennsylvania", () => {
  assert.deepEqual(MD_RECIPROCITY_AGREEMENTS.map((row) => row.residenceRegion).sort(), ["DC", "VA", "WV"]);
  assert.ok(MD_RECIPROCITY_AGREEMENTS.every((row) => row.certificateKey === "us_md_mw507_nr"));
  assert.ok(MD_RECIPROCITY_AGREEMENTS.every((row) => row.relievesSubRegionLevies === true));
  assert.equal(MD_MW507_NR.fields[0]!.choices!.map((choice) => choice.value).sort().join(","), "DC,VA,WV");
});

test("MD Guide annual combined tables — official plus amounts", () => {
  // Guide p. 39 (3.20% local) single and joint/HoH; Guide p. 15 (2.25% local, Worcester / nonresident) single.
  const cells = [
    ["single", "3.20", [["100000", "7950"], ["125000", "10000"], ["150000", "12112.50"], ["250000", "20812.50"],
      ["500000", "43187.50"], ["1000000", "90437.50"]]],
    ["joint", "3.20", [["150000", "11925"], ["175000", "13975"], ["225000", "18200"], ["300000", "24725"],
      ["600000", "51575"], ["1200000", "108275"]]],
    ["single", "2.25", [["100000", "7000"], ["125000", "8812.50"], ["150000", "10687.50"], ["250000", "18437.50"],
      ["500000", "38437.50"], ["1000000", "80937.50"]]],
  ] as const;
  for (const [schedule, localPercent, rows] of cells) {
    for (const [taxable, plus] of rows) {
      assert.equal(D(mdAnnualCombinedTax({ taxable: U(taxable), schedule, localPercent }).tax), money(plus),
        `${schedule} ${localPercent}% at $${taxable}`);
    }
  }
  // Guide p. 37 weekly (b): $0–$1,923 at 7.95%; the next line prints "$152.88 plus 8.20%".
  assert.equal(D(mulRateCents(U("1923"), mdCombinedRate("4.75", "3.20"))), money("152.88"));
  for (const [state, local, combined] of [["4.75", "3.20", "7.95"], ["4.75", "2.25", "7"], ["6.50", "3.30", "9.8"]] as const) {
    assert.equal(addPrintedPercents(state, local), combined, `${state} + ${local}`);
  }
  assert.equal(mdCombinedRate("4.75", "3.20"), pctToRate("7.95"));
});

test("MD Tax Facts 2026 publishes 24 local jurisdictions and the table-grouping rule", () => {
  assert.equal(MD_COUNTIES_2026.length, 24);
  assert.equal(new Set(MD_COUNTIES_2026.map((c) => c.code)).size, 24);
  assert.equal(mdCounty("16").name, "Montgomery");
  assert.equal(mdCounty("MG").rate, "3.20");
  // [code, actual rate, table percent]: a table is the one closest to the actual rate without going below it.
  for (const [code, rate, table, name] of [
    ["24", "2.25", undefined, "Worcester (lowest)"], ["10", "3.30", undefined, "Dorchester"],
    ["15", "3.30", undefined, "Kent"], ["07", "3.03", "3.05", "Carroll"], ["08", undefined, "2.75", "Cecil 2.74"],
    ["13", undefined, "3.10", "Harford 3.06"], ["22", undefined, "3.00", "Washington 2.95"],
    ["02", "graduated", undefined, "Anne Arundel"], ["11", "graduated", undefined, "Frederick"],
  ] as const) {
    if (rate) assert.equal(mdCounty(code).rate, rate, name);
    if (table) assert.equal(mdCounty(code).tablePercent, table, name);
  }
  assert.throws(() => mdCounty("99"), /not a Maryland county/);
});

test("MD MW507 status boxes map onto the Guide's two schedules; Anne Arundel's joint first slice is $75,000", () => {
  for (const [status, schedule] of [
    ["single", "single"], ["married_single_rate", "single"], ["married_joint_hoh", "joint"], [null, "single"],
  ] as const) assert.equal(mdScheduleFor(status), schedule, String(status));
  // Guide p. 9: $60,000 joint taxable stays inside the 2.70% first slice.
  assert.equal(D(mdAnneArundelLocal(U("60000"), "joint")), money("1620"));
});

test("MD lump-sum annual bonus is 6.50% + highest local — exported, while compute aggregates", () => {
  // Guide p. 9: Montgomery highest local 3.20%, combined 9.70%; $1,000 × 9.70% = $97.00.
  assert.equal(
    mdLumpSumBonus({ payDate: "2026-03-06", amount: "1000.00", county: mdCounty("16"), basis: "resident" }),
    money("97"),
  );
  const answers = { filing_status: "single", exemptions: "1", residence_county: "16" };
  const aggregated = compute({
    state: "MD", answers, input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", supplemental: "1000.00" },
  });
  const together = compute({ state: "MD", answers, input: { payDate: "2026-03-06", periodsPerYear: 52, wages: "2000.00" } });
  assert.equal(aggregated.tax, together.tax);
  assert.equal(aggregated.taxSupplemental, money("0"));
  assert.notEqual(aggregated.tax, money("97"));
});

test("MD Delaware schedule withholds 3.30% net of the Delaware credit — no county", () => {
  // 2026 Delaware schedule (pp. 10–12): $10,000 monthly, single, one exemption → $120,000 − $6,600 =
  // $113,400; the $100,000–$125,000 band prices $3,300 + 3.30% × $13,400 = $3,742.20 a year, $311.85 a month.
  const result = mdDelawareResidentTax({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "10000.00",
    certificate: resolvedCertificate(payrollCertificate("US", "us_md_mw507"), { filing_status: "single", exemptions: "1" }),
  });
  assert.equal(result.factors.MD_DE_SCHEDULE, "delaware-2026");
  assert.equal(result.statutoryTax, money("311.85"));
});

test("MN Step-5 addends ARE the tax on everything below each band", () => {
  // 2026 MN Computer Formula p. 34. A transcription slip in a rate, a threshold
  // or a printed addend ($1,782.09 / $6,958.25 / $14,315.27; $2,605.45 / $12,450.49 / $23,789.82) shows here.
  for (const [schedule, bands] of Object.entries(MN_RATES_2026.schedules)) {
    for (let i = 1; i < bands.length; i++) {
      const below = bands[i - 1]!;
      const expected = U(below.add) + mulRateCents(U(bands[i]!.moreThan) - U(below.subtract), below.rate);
      assert.equal(D(expected), money(bands[i]!.add), `MN ${schedule} band ${i}`);
    }
  }
});

test("NM every schedule chains without gaps or overlaps", () => {
  // FYI-104 Tables 1–8: 3 statuses × 8 periods × 10 rows, each "Over" the previous "But Not Over".
  let rows = 0;
  for (const [status, tables] of Object.entries(NM_RATES_2026.tables)) {
    for (const [period, table] of Object.entries(tables)) {
      const at = `NM ${status} ${period}`;
      assert.equal(table.rows.length, 10, at);
      assert.equal(table.rows[0]!.over, "0", at);
      table.rows.slice(1).forEach((row, i) => assert.equal(row.over, table.rows[i]!.butNotOver, `${at} row ${i + 1}`));
      assert.equal(table.rows.at(-1)!.butNotOver, null, at);
      rows += table.rows.length;
    }
  }
  assert.equal(rows, 240);
});

test("supplemental paid separately takes the state's flat rate, not the table", () => {
  for (const [actual, expected, note] of [
    [mnSupplementalFlat("2026-03-15", "4000.00"), "250", "MN 2026 booklet p. 7 Method 2: 6.25%"],
    [nmSupplementalFlat("200.00"), "11.80", "NM FYI-104 p. 4: 5.9%"],
    [nmSupplementalFlat("1000.00"), "59", "NM FYI-104 p. 4: 5.9%"],
  ] as const) {
    assert.equal(actual, money(expected), note);
  }
});

test("MN Paid Leave prices the assessed employer premium on covered wages", () => {
  // $10,000 of Minnesota work at the designated 0.88% is $88; the DEED
  // small-employer answer is recorded for the quarterly report.
  const employer = computeUsEmployerWithholding({
    levy: {
      level: "sub_region", region: "MN", subRegion: "PL", label: "Minnesota Paid Leave premium (employer)",
      basis: "nonresident", side: "work", reach: "nonresident", certificateKey: null,
    },
    payDate: "2026-03-15", wages: "10000.00", ytdWages: "0",
    tenantRates: () => ({ rate: "0.0088", small_employer: "false" }),
  });
  assert.equal(employer.tax, money("88"));
  assert.equal(employer.factors.MNPL_SMALL_EMPLOYER, "false");
});

test("Ohio 2026 district declarations retain the Department's legal names", () => {
  for (const [code, name] of [
    ["1105", "West Liberty-Salem LSD (1.00% expires 2027; 0.25% expires 2036; 0.50% CPT)"],
    ["1905", "Mississinawa Valley LSD (0.75% expires 2031; 1.00% CPT)"],
    ["2602", "Evergreen LSD (0.25% expires 2027; 0.50% expires 2029; 0.75% CPT)"],
    ["2605", "Pike-Delta-York LSD (existing 1% expires 2026, 1.25% CPT begins 2027)"],
    ["4902", "Jonathan Alder LSD (0.75% expires 2026, 0.50% expires 2031)"],
    ["5708", "New Lebanon LSD (0.75% expires 2030; 0.50% expires 2031)"],
    ["6805", "Twin Valley Community LSD (0.75% expires 2027; 0.75% expires 2028)"],
    ["6901", "Columbus Grove LSD (0.75% expires 2030; 0.25% expires 2032)"],
    ["6909", "Pandora-Gilboa LSD (1.00% expires 2036; 0.75% expires 2033)"],
    ["7201", "Clyde-Green Springs EVSD (0.50% expires 2030; 1.00% CPT)"],
    ["8705", "North Baltimore LSD (1.00% expires 2027; 0.25% expires 2034)"],
  ] as const) {
    assert.equal(ohSchoolDistrict("2026-01-01", code)?.name, name, code);
    assert.equal(OH_SCHOOL_DISTRICTS_2026.find((district) => district.code === code)?.name, name, code);
  }
});

test("printed trace figures that are not amounts (band floors, addends, edition, reasons)", () => {
  // The golden rows run every factor through money(); these factors are printed as bare
  // figures or codes, so they are asserted verbatim against the row that produces them.
  const cases: Array<[state: string, label: string, factors: Record<string, string>]> = [
    ["OR", "Example 1 — annual $25,000 single 0 allowances, $1,000 FIT: $1,789", { OR_BAND_ADD: "941" }],
    ["UT", "Rev. 4/25 Example 2 — biweekly $2,600, Single: $117", { UT_EDITION: "2026-01-01" }],
    ["VA", "p. 21 John — semi-monthly $2,649, five exemptions: $109.48 (printed $109.50)", { VA_BAND_OVER: "17000" }],
    ["WV", "two-earner weekly substitute — $800, 0 exemptions: $25", { WV_SCHEDULE: "two_earner", WV_BAND_OVER: "577" }],
    ["WV", "IT-104 line 5 elects the one-earner schedule — $800: $23", { WV_SCHEDULE: "one_earner", WV_BAND_OVER: "769" }],
    ["WV", "IT-104NR claim from a non-reciprocal state (NY) withholds in full: $25", { WV_RECIPROCAL_EXEMPTION_NOT_APPLIED: "ineligible_resident_state" }],
    ["WV", "Guard/Reserve excepted-duty military pay stays taxable: $25", { WV_MILITARY_PAY_TAXABLE: "guard_reserve_excepted_duty" }],
  ];
  for (const [state, label, factors] of cases) {
    const row = GOLDENS.find((golden) => golden.state === state && golden.label === label);
    assert.ok(row, `${state} ${label}: no such golden row`);
    const result = compute(row);
    for (const [factor, expected] of Object.entries(factors)) {
      assert.equal(result.factors[factor], expected, `${state} ${label} (${row.citation}): ${factor}`);
    }
  }
});

test("OR 150-206-436 Examples 3, 4 and FAQ 7 — the annual phase-out, allowance and bracket rules", () => {
  // Examples 3 and 4 print no final dollar, so they are asserted on the annual formula's trace.
  const cases: Array<[note: string, wages: string, federal: string, status: "single" | "married_higher_single", allowances: number, factors: Record<string, string>]> = [
    // "$132,000 … federal tax withheld is $21,098 … they may only subtract [the phase-out amount]":
    // the 2026 [S] step for $130,000–$135,000 is $5,250 (2025 printed $5,100). 132,000 − 5,250 − 2,910.
    ["Example 3", "132000", "21098", "single", 4, {
      OR_FEDERAL_CAP: money("5250"), OR_FEDERAL_USED: money("5250"), OR_ALLOWANCES: "0",
      OR_STANDARD_DEDUCTION: money("2910"), OR_BASE: money("123840"),
    }],
    // Married at the higher single rate, $175,000: above the $145,000 single phase-out end, so no
    // federal subtraction; above $100,000 single, so no allowances.
    ["Example 4", "175000", "30000", "married_higher_single", 4, {
      OR_PHASE: "single", OR_BRACKETS: "single", OR_FEDERAL_CAP: money("0"), OR_FEDERAL_USED: money("0"),
      OR_ALLOWANCES: "0", OR_STANDARD_DEDUCTION: money("2910"), OR_BASE: money("172090"),
    }],
    // Single with 3+ allowances: single phase-out, married brackets and the $5,820 deduction.
    ["FAQ 7", "40000", "2000", "single", 3, {
      OR_PHASE: "single", OR_BRACKETS: "married_or_3plus", OR_STANDARD_DEDUCTION: money("5820"), OR_FEDERAL_CAP: money("8750"),
    }],
  ];
  for (const [note, wages, federal, status, claimedAllowances, factors] of cases) {
    const annual = orAnnualWithholding({
      annualWages: U(wages), annualFederalWithheld: U(federal), status, claimedAllowances, rates: OR_RATES_2026,
    });
    for (const [factor, expected] of Object.entries(factors)) {
      assert.equal(annual.factors[factor], expected, `OR 150-206-436 (Rev. 12-31-25) ${note}: ${factor}`);
    }
  }
});

test("OR 150-206-436 printed addends are the tax on everything below each band", () => {
  // Each next low-wage addend is the prior addend plus (width × rate) rounded to the dollar — the
  // unit Example 1 line 7 uses. The high-wage first addend drops one $263 credit from the low-wage
  // top addend; its second addend is the tax at the 8.75% ceiling ($125,000 single / $250,000 joint).
  const low = OR_RATES_2026.low;
  const high = OR_RATES_2026.high;
  const next = (band: { add: string; subtract: string; rate: string }, to: string) =>
    D(U(band.add) + orMulRateDollars(U(to) - U(band.subtract), band.rate));
  for (const table of ["single", "married_or_3plus"] as const) {
    const [b0, b1, b2] = low[table];
    assert.equal(next(b0!, b1!.atLeast), money(b1!.add), `OR low ${table} band 2 addend`);
    assert.equal(next(b1!, b2!.atLeast), money(b2!.add), `OR low ${table} band 3 addend`);
    assert.equal(D(U(b2!.add) - U(OR_RATES_2026.exemptionCredit)), money(high[table][0]!.add), `OR high ${table} first addend`);
    const ceiling = table === "single" ? "125000" : "250000";
    assert.equal(next(high[table][0]!, ceiling), money(high[table][1]!.add), `OR high ${table} 9.9% addend`);
  }
});

test("published figures on helpers that no compute row reaches", () => {
  const cases: Array<[actual: () => string, expected: string, note: string]> = [
    // Example 2: "take the annual net tax to be withheld ($1,789) and divide by 12 = $149 …"
    ...([[12, "149"], [24, "75"], [26, "69"], [52, "34"], [260, "7"]] as const).map(([periods, expected]) => [
      () => D(orRoundToDollar(divIntCents(U("1789"), periods))), expected,
      `OR 150-206-436 Example 2: $1,789 ÷ ${periods}`,
    ] as [() => string, string, string]),
    [() => orSupplementalFlat("2026-03-13", "4000.00"), "320", "OR 150-206-436 FAQ 5: optional 8% supplemental flat"],
    [() => D(scAnnualTax(U("3639.99"), SC_RATES_2026)), "0", "SC WH-1603F: nothing below the $3,640 first bracket"],
    [() => D(scStandardDeduction(U("100000"), 1, SC_RATES_2026)), "7500", "SC WH-1603F: 10% standard deduction capped at $7,500"],
    [() => vaSupplementalFlat("2026-03-15", "1000.00"), "57.50", "VA Guide p. 19: 5.75% flat on a separately-paid supplemental"],
    [() => D(wiDeduction(U("73630"), "single", WI_RATES_2026)), "0", "WI W-166: $6,702 − 12% × ($73,630 − $17,780) ends at zero"],
    [() => D(wiDeduction(U("17779.99"), "single", WI_RATES_2026)), "6702", "WI W-166: full single deduction below $17,780"],
    [() => D(wiDeduction(U("73032"), "married", WI_RATES_2026)), "0", "WI W-166: married deduction ends at $73,032"],
    [() => D(wiAnnualTax(0n, WI_RATES_2026)), "0", "WI W-166: no tax on no net wages"],
    [() => D(wvRoundToDollar(U("25.36"))), "25", "WV IT-100.2A: nearest dollar, down"],
    [() => D(wvRoundToDollar(U("25.50"))), "26", "WV IT-100.2A: nearest dollar, half up"],
    [() => utahEmployerWaiverResult().tax, "0", "UT Tax Commission employer waiver withholds nothing"],
  ];
  for (const [actual, expected, note] of cases) assert.equal(actual(), money(expected), note);
});

test("OR transit levies: rates are entered, never invented, and priced on the employer's side", () => {
  // 150-206-436 publishes no TriMet or LTD rate: the rate is employer-entered (0.008 and 0.01 below
  // are arbitrary entered figures proving the path and arithmetic), and without one the levy refuses.
  assert.throws(
    () => orTransitWithholding({ wages: "2000.00", rate: null, district: "TriMet" }),
    /150-206-436.*does not publish TriMet or Lane Transit/s,
  );
  assert.throws(
    () => orTransitWithholding({ wages: "2000.00", rate: "", district: "Lane Transit District" }),
    /Inventing 0\.8237% or 0\.80% from Form OQ/,
  );
  assert.equal(orTransitWithholding({ wages: "1000.00", rate: "0.01", district: "TriMet" }), money("10"));

  // An employer levy reaching the deduction path would post the employer's tax as a stub deduction.
  const trimet = {
    level: "sub_region", region: "OR", subRegion: "TRIMET", label: "TriMet transit payroll tax",
    basis: "nonresident", side: "work", reach: "nonresident", certificateKey: null,
  } as const;
  const tenantRates = () => ({ rate: "0.008" });
  assert.throws(
    () => computeUsWithholding({
      levy: { ...trimet }, payDate: "2026-07-21", periodEnd: "2026-07-18", periodsPerYear: 26,
      wages: "2000.00", federalIncomeTax: "100.00", certificateFor: () => null, tenantRates,
    }),
    /employer payroll tax, not employee withholding.*never as a stub deduction/s,
  );
  const employer = computeUsEmployerWithholding({
    levy: { ...trimet }, wages: "2000.00", tenantRates,
    wageAllocations: [{ region: "OR", subRegion: "TRIMET", workShare: "0.4", source: "approved_time_entries", sourceWagesCurrentPeriod: "800.00" }],
  });
  assert.deepEqual([employer.code, employer.tax, employer.factors.OR_TRANSIT_RATE], ["OR-TRIMET", money("6.40"), "0.008"]);

  const ltd = { ...trimet, subRegion: "LTD", label: "Lane Transit District payroll tax" } as const;
  assert.throws(
    () => computeUsEmployerWithholding({
      levy: { ...ltd }, wages: "2000.00", tenantRates: () => undefined,
      wageAllocations: [{ region: "OR", subRegion: "LTD", workShare: "1", source: "employer work records", sourceWagesCurrentPeriod: "2000.00" }],
    }),
    /no transit payroll-tax rate has been entered for Lane Transit District/,
  );
  // No recorded in-district share refuses rather than pricing the whole period as district wages.
  assert.throws(
    () => computeUsEmployerWithholding({ levy: { ...ltd }, wages: "2000.00", tenantRates }),
    /OR\/LTD needs exactly one current-period work allocation/,
  );

  // The statewide transit tax is automatic and withheld from the employee at 0.1%.
  const stt = OR_REGION.subRegions.find((sub) => sub.code === "STT");
  assert.equal(stt?.automatic, true);
  const statewide = computeUsWithholding({
    levy: {
      level: "sub_region", region: "OR", subRegion: "STT", label: stt!.label, basis: "resident", side: "residence",
      reach: "resident", certificateKey: null, statutoryComponent: stt!.statutoryComponent, withholdingMethod: stt!.withholdingMethod,
    },
    payDate: "2026-07-21", periodEnd: "2026-07-18", periodsPerYear: 26,
    wages: "1000.00", federalIncomeTax: "0.00", certificateFor: () => null, tenantRates: () => undefined,
  });
  assert.equal(statewide?.tax, money("1.00"));
});

test("VT Child Care Contribution accrues 0.44% of Vermont wages at the employer's cost", () => {
  // WHT-436 Part III: $100,000 of Vermont work prices $440 of employer liability; with no
  // employee-share election entered, no employee line prices.
  const levy = {
    level: "sub_region", region: "VT", subRegion: "CCC", label: "Vermont Child Care Contribution (employer)",
    basis: "nonresident", side: "work", reach: "nonresident", certificateKey: null,
  } as const;
  assert.equal(computeUsEmployerWithholding({ levy: { ...levy }, payDate: "2026-07-21", wages: "100000.00", tenantRates: () => undefined }).tax, money("440"));
});
