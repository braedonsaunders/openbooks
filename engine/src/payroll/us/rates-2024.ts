/**
 * US federal payroll withholding constants for 2024.
 *
 * Sources (fetched from irs.gov / govinfo.gov, not memory):
 *   Pub 15-T (2024), Federal Income Tax Withholding Methods — For use in
 *     2024 (Cat. No. 32112B): irs.gov/pub/irs-prior/p15t--2024.pdf —
 *     §1 Annual Percentage Method Tables for Automated Payroll Systems
 *     (STANDARD and Form W-4 Step 2 Checkbox schedules, p. 11) plus the
 *     Worksheet 1A constants (line 1g: $12,900 MFJ / $8,600 otherwise;
 *     line 1k: $4,300 per allowance, p. 9).
 *   SSA OASDI wage base: Federal Register 2023-23317, "Cost-of-Living
 *     Increase and Other Determinations for 2024" (2023-10-23): the OASDI
 *     contribution and benefit base is $168,600 for 2024.
 *   Rev. Proc. 2023-34 (annual inflation adjustments): §.01 §1 rate tables
 *     (the bracket boundaries the STANDARD thresholds are derived from)
 *     and §.15 standard deduction ($29,200 MFJ / $21,900 HoH / $14,600
 *     single or married filing separately).
 *   FUTA: IRC §3301/§3302 — 6.0% on the first $7,000, up to 5.4% credit
 *     (unchanged); supplemental-wage flat rates per Pub 15 §7 (22%,
 *     mandatory 37% past $1,000,000 YTD supplemental — unchanged).
 *
 * Cross-verification (part of transcription, 2026-09-20):
 *   - Each tentative amount equals the cumulative tax of the prior brackets
 *     (e.g. STANDARD MFJ: 10% × (39,500 − 16,300) = 2,320;
 *     2,320 + 12% × (110,600 − 39,500) = 10,852;
 *     10,852 + 22% × (217,350 − 110,600) = 34,337;
 *     34,337 + 24% × (400,200 − 217,350) = 78,221;
 *     78,221 + 32% × (503,750 − 400,200) = 111,357;
 *     111,357 + 35% × (747,500 − 503,750) = 196,669.50 — all six match).
 *   - Each STANDARD threshold equals the Rev. Proc. 2023-34 §1 bracket
 *     boundary shifted by the standard deduction less the Worksheet 1A
 *     adjustment ($12,900 MFJ / $8,600 otherwise): single 11,600 + 6,000 =
 *     17,600; MFJ 23,200 + 16,300 = 39,500; HoH 16,550 + 13,300 = 29,850
 *     (and likewise for every higher row of all three statuses).
 *   - Each Checkbox threshold equals (boundary + standard deduction) ÷ 2,
 *     whole-dollar rounded: single (100,525 + 14,600) ÷ 2 = 57,562.50 →
 *     57,563; (243,725 + 14,600) ÷ 2 = 129,162.50 → 129,163 — the printed
 *     schedule rounds two half-dollar boundaries up, exactly as the 2026
 *     schedule does. Each Checkbox tentative is half the STANDARD tentative
 *     at the same boundary (183,647.25 ÷ 2 = 91,823.625 → 91,823.63).
 *   - FICA maximum consistent with rate and wage base
 *     (168,600 × 0.062 = 10,453.20).
 */

import type { FilingStatus, WithholdingRow, YearRates } from "./rates.ts";

// 2024 Annual Percentage Method Tables — STANDARD Withholding Rate Schedules.
const STANDARD_2024: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "16300", tentative: "0", rate: "0.10" },
    { atLeast: "39500", tentative: "2320", rate: "0.12" },
    { atLeast: "110600", tentative: "10852", rate: "0.22" },
    { atLeast: "217350", tentative: "34337", rate: "0.24" },
    { atLeast: "400200", tentative: "78221", rate: "0.32" },
    { atLeast: "503750", tentative: "111357", rate: "0.35" },
    { atLeast: "747500", tentative: "196669.50", rate: "0.37" },
  ],
  single: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "6000", tentative: "0", rate: "0.10" },
    { atLeast: "17600", tentative: "1160", rate: "0.12" },
    { atLeast: "53150", tentative: "5426", rate: "0.22" },
    { atLeast: "106525", tentative: "17168.50", rate: "0.24" },
    { atLeast: "197950", tentative: "39110.50", rate: "0.32" },
    { atLeast: "249725", tentative: "55678.50", rate: "0.35" },
    { atLeast: "615350", tentative: "183647.25", rate: "0.37" },
  ],
  head_household: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "13300", tentative: "0", rate: "0.10" },
    { atLeast: "29850", tentative: "1655", rate: "0.12" },
    { atLeast: "76400", tentative: "7241", rate: "0.22" },
    { atLeast: "113800", tentative: "15469", rate: "0.24" },
    { atLeast: "205250", tentative: "37417", rate: "0.32" },
    { atLeast: "257000", tentative: "53977", rate: "0.35" },
    { atLeast: "622650", tentative: "181954.50", rate: "0.37" },
  ],
};

// 2024 Form W-4, Step 2, Checkbox Withholding Rate Schedules.
const CHECKBOX_2024: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "14600", tentative: "0", rate: "0.10" },
    { atLeast: "26200", tentative: "1160", rate: "0.12" },
    { atLeast: "61750", tentative: "5426", rate: "0.22" },
    { atLeast: "115125", tentative: "17168.50", rate: "0.24" },
    { atLeast: "206550", tentative: "39110.50", rate: "0.32" },
    { atLeast: "258325", tentative: "55678.50", rate: "0.35" },
    { atLeast: "380200", tentative: "98334.75", rate: "0.37" },
  ],
  single: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "7300", tentative: "0", rate: "0.10" },
    { atLeast: "13100", tentative: "580", rate: "0.12" },
    { atLeast: "30875", tentative: "2713", rate: "0.22" },
    { atLeast: "57563", tentative: "8584.25", rate: "0.24" },
    { atLeast: "103275", tentative: "19555.25", rate: "0.32" },
    { atLeast: "129163", tentative: "27839.25", rate: "0.35" },
    { atLeast: "311975", tentative: "91823.63", rate: "0.37" },
  ],
  head_household: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "10950", tentative: "0", rate: "0.10" },
    { atLeast: "19225", tentative: "827.50", rate: "0.12" },
    { atLeast: "42500", tentative: "3620.50", rate: "0.22" },
    { atLeast: "61200", tentative: "7734.50", rate: "0.24" },
    { atLeast: "106925", tentative: "18708.50", rate: "0.32" },
    { atLeast: "132800", tentative: "26988.50", rate: "0.35" },
    { atLeast: "315625", tentative: "90977.25", rate: "0.37" },
  ],
};

export const RATES_2024: YearRates = {
  year: 2024,
  status: "published",
  standard: STANDARD_2024,
  checkbox: CHECKBOX_2024,
  wageAdjustment: { marriedJoint: "12900", other: "8600" },
  allowanceAmount: "4300",
  fica: {
    ssRate: "0.062",
    ssWageBase: "168600",
    medicareRate: "0.0145",
    additionalMedicareRate: "0.009",
    additionalMedicareThreshold: "200000",
  },
  futa: {
    wageBase: "7000",
    grossRate: "0.06",
    fullCreditEffectiveRate: "0.006",
  },
  supplemental: {
    flatRate: "0.22",
    mandatoryHighRate: "0.37",
    mandatoryThreshold: "1000000",
  },
};
