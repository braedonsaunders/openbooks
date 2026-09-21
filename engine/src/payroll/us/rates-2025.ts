/**
 * US federal payroll withholding constants for 2025.
 *
 * Sources (fetched from irs.gov / govinfo.gov, not memory):
 *   Pub 15-T (2025), Federal Income Tax Withholding Methods — For use in
 *     2025 (Cat. No. 32112B): irs.gov/pub/irs-prior/p15t--2025.pdf —
 *     §1 Annual Percentage Method Tables for Automated Payroll Systems
 *     (STANDARD and Form W-4 Step 2 Checkbox schedules, p. 11) plus the
 *     Worksheet 1A constants (line 1g: $12,900 MFJ / $8,600 otherwise;
 *     line 1k: $4,300 per allowance, p. 9).
 *   SSA OASDI wage base: Federal Register 2024-24871, "Cost-of-Living
 *     Increase and Other Determinations for 2025" (2024-10-25): the OASDI
 *     contribution and benefit base is $176,100 for 2025.
 *   Rev. Proc. 2024-40 (annual inflation adjustments): §.01 §1 rate tables
 *     (the bracket boundaries the STANDARD thresholds are derived from)
 *     and §.15 standard deduction ($30,000 MFJ / $22,500 HoH / $15,000
 *     single or married filing separately).
 *   FUTA: IRC §3301/§3302 — 6.0% on the first $7,000, up to 5.4% credit
 *     (unchanged); supplemental-wage flat rates per Pub 15 §7 (22%,
 *     mandatory 37% past $1,000,000 YTD supplemental — unchanged).
 *
 * Cross-verification (part of transcription, 2026-09-20):
 *   - Each tentative amount equals the cumulative tax of the prior brackets
 *     (e.g. STANDARD MFJ: 10% × (40,950 − 17,100) = 2,385;
 *     2,385 + 12% × (114,050 − 40,950) = 11,157;
 *     11,157 + 22% × (223,800 − 114,050) = 35,302;
 *     35,302 + 24% × (411,700 − 223,800) = 80,398;
 *     80,398 + 32% × (518,150 − 411,700) = 114,462;
 *     114,462 + 35% × (768,700 − 518,150) = 202,154.50 — all six match).
 *   - Each STANDARD threshold equals the Rev. Proc. 2024-40 §1 bracket
 *     boundary shifted by the standard deduction less the Worksheet 1A
 *     adjustment ($12,900 MFJ / $8,600 otherwise): single 11,925 + 6,400 =
 *     18,325; MFJ 23,850 + 17,100 = 40,950; HoH 17,000 + 13,900 = 30,900
 *     (and likewise for every higher row of all three statuses).
 *   - Each Checkbox threshold equals (boundary + standard deduction) ÷ 2,
 *     whole-dollar rounded: single (11,925 + 15,000) ÷ 2 = 13,462.50 →
 *     13,463; (48,475 + 15,000) ÷ 2 = 31,737.50 → 31,738;
 *     (250,525 + 15,000) ÷ 2 = 132,762.50 → 132,763 — the printed schedule
 *     rounds three half-dollar boundaries up, exactly as the 2026 schedule
 *     does two. Each Checkbox tentative is half the STANDARD tentative at
 *     the same boundary (188,769.75 ÷ 2 = 94,384.875 → 94,384.88).
 *   - FICA maximum consistent with rate and wage base
 *     (176,100 × 0.062 = 10,918.20).
 */

import type { FilingStatus, WithholdingRow, YearRates } from "./rates.ts";

// 2025 Annual Percentage Method Tables — STANDARD Withholding Rate Schedules.
const STANDARD_2025: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "17100", tentative: "0", rate: "0.10" },
    { atLeast: "40950", tentative: "2385", rate: "0.12" },
    { atLeast: "114050", tentative: "11157", rate: "0.22" },
    { atLeast: "223800", tentative: "35302", rate: "0.24" },
    { atLeast: "411700", tentative: "80398", rate: "0.32" },
    { atLeast: "518150", tentative: "114462", rate: "0.35" },
    { atLeast: "768700", tentative: "202154.50", rate: "0.37" },
  ],
  single: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "6400", tentative: "0", rate: "0.10" },
    { atLeast: "18325", tentative: "1192.50", rate: "0.12" },
    { atLeast: "54875", tentative: "5578.50", rate: "0.22" },
    { atLeast: "109750", tentative: "17651", rate: "0.24" },
    { atLeast: "203700", tentative: "40199", rate: "0.32" },
    { atLeast: "256925", tentative: "57231", rate: "0.35" },
    { atLeast: "632750", tentative: "188769.75", rate: "0.37" },
  ],
  head_household: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "13900", tentative: "0", rate: "0.10" },
    { atLeast: "30900", tentative: "1700", rate: "0.12" },
    { atLeast: "78750", tentative: "7442", rate: "0.22" },
    { atLeast: "117250", tentative: "15912", rate: "0.24" },
    { atLeast: "211200", tentative: "38460", rate: "0.32" },
    { atLeast: "264400", tentative: "55484", rate: "0.35" },
    { atLeast: "640250", tentative: "187031.50", rate: "0.37" },
  ],
};

// 2025 Form W-4, Step 2, Checkbox Withholding Rate Schedules.
const CHECKBOX_2025: Record<FilingStatus, WithholdingRow[]> = {
  married_joint: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "15000", tentative: "0", rate: "0.10" },
    { atLeast: "26925", tentative: "1192.50", rate: "0.12" },
    { atLeast: "63475", tentative: "5578.50", rate: "0.22" },
    { atLeast: "118350", tentative: "17651", rate: "0.24" },
    { atLeast: "212300", tentative: "40199", rate: "0.32" },
    { atLeast: "265525", tentative: "57231", rate: "0.35" },
    { atLeast: "390800", tentative: "101077.25", rate: "0.37" },
  ],
  single: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "7500", tentative: "0", rate: "0.10" },
    { atLeast: "13463", tentative: "596.25", rate: "0.12" },
    { atLeast: "31738", tentative: "2789.25", rate: "0.22" },
    { atLeast: "59175", tentative: "8825.50", rate: "0.24" },
    { atLeast: "106150", tentative: "20099.50", rate: "0.32" },
    { atLeast: "132763", tentative: "28615.50", rate: "0.35" },
    { atLeast: "320675", tentative: "94384.88", rate: "0.37" },
  ],
  head_household: [
    { atLeast: "0", tentative: "0", rate: "0" },
    { atLeast: "11250", tentative: "0", rate: "0.10" },
    { atLeast: "19750", tentative: "850", rate: "0.12" },
    { atLeast: "43675", tentative: "3721", rate: "0.22" },
    { atLeast: "62925", tentative: "7956", rate: "0.24" },
    { atLeast: "109900", tentative: "19230", rate: "0.32" },
    { atLeast: "136500", tentative: "27742", rate: "0.35" },
    { atLeast: "324425", tentative: "93515.75", rate: "0.37" },
  ],
};

export const RATES_2025: YearRates = {
  year: 2025,
  status: "published",
  standard: STANDARD_2025,
  checkbox: CHECKBOX_2025,
  wageAdjustment: { marriedJoint: "12900", other: "8600" },
  allowanceAmount: "4300",
  fica: {
    ssRate: "0.062",
    ssWageBase: "176100",
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
