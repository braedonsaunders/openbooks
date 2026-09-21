/**
 * GB payroll pack rate declarations: the transcribed 2025/26 HMRC tables.
 *
 * Every figure below carries the authority's own table and a quoted figure.
 * All sources returned HTTP 200 on 2026-09-20: the two HMRC employer pages
 * live on gov.uk (superseded years stay published — exactly what a prior
 * year needs); the P9X PDFs were reached through the Wayback Machine after
 * their assets.publishing.service.gov.uk originals returned HTTP 410
 * (36-byte bodies, the same gone-asset shape rates.ts records); the
 * scottish-income-tax, welsh-income-tax and income-tax-rates pages through
 * dated Wayback snapshots; the DWP reviews live on gov.uk.
 *
 * Transcribed (engine reads these):
 * - rUK PAYE bands + the £12,570 Personal Allowance with its £100,000 taper.
 * - The 2025/26 Scotland bands (a separate edition, never a column).
 * - Class 1 NIC category-A thresholds (annual/weekly/monthly) and rates:
 *   employee 8%/2%, employer 15% — the Autumn Budget 2024 rise, effective
 *   6 April 2025 (the year boundary, not mid-year: one edition per scope).
 *
 * Declared but NOT computed (tenant-entered or refused by name, as in 2026):
 * - Employment Allowance (£10,500): eligibility is conditional (see
 *   rates.ts), so it is a tenant-entered slot, never a computed constant.
 * - Auto-enrolment trigger + qualifying-earnings band: declared data, no
 *   engine (minimum contributions ride each employer's scheme).
 * - Student-loan / postgraduate-loan thresholds, Class 1A/1B, statutory
 *   sick/maternity pay, the apprenticeship levy and RTI mechanics:
 *   named, declared nothing.
 *
 * Cross-verification (part of transcription, 2026-09-20):
 * - Each Scottish gross-space top (scottish-income-tax 2025 to 2026 table:
 *   £15,397 / £27,491 / £43,662 / £75,000) is exactly £12,570 above the
 *   taxable-space top below — the two pages agree, so no Budget papers are
 *   needed. The £125,140 top is shared (the taper-zero point), not shifted.
 * - Weekly/monthly NIC figures are HMRC's published roundings, never
 *   annual ÷ 52 or ÷ 12: £5,000 ÷ 12 = £416.67, published £417.
 * - The employer 15% rate and £5,000 secondary threshold are the announced
 *   change: the 2024 to 2025 page prints 13.8% and £9,100 for the same
 *   cells, so no 2026 value was carried back.
 */

import type { GbNicThresholds, GbRukBand, GbSctBand } from "./rates.ts";

/** First day of the 2025/26 GB tax year. */
export const GB_2025_TAX_YEAR_START = "2025-04-06";

/** Last day of the 2025/26 GB tax year. */
export const GB_2025_TAX_YEAR_END = "2026-04-05";

/** Last pay date whose record is complete by definition (tax month 1). */
export const GB_2025_MONTH_ONE_END = "2025-05-05";

/**
 * Standard Personal Allowance 2025/26: £12,570 a year.
 * Employer rates page (England/NI, Scotland AND Wales sections alike):
 * "The standard employee personal allowance for the 2025 to 2026 tax year
 * is: £242 per week £1,048 per month £12,570 per year". P9X(2025):
 * "For 2025 to 2026 the basic Personal Allowance will be £12,570 for the
 * whole of the UK. The threshold (starting point) for PAYE is £242 per week
 * (£1,048 per month)."
 */
export const GB_2025_PERSONAL_ALLOWANCE_ANNUAL = "12570";

/**
 * Taper: above £100,000 the allowance falls £1 for every £2 of adjusted net
 * income, reaching zero at £125,140. Income-tax-rates (June 2025 snapshot,
 * "The current tax year is from 6 April 2025 to 5 April 2026"): "Your
 * personal allowance goes down by £1 for every £2 that your adjusted net
 * income is above £100,000. This means your allowance is zero if your income
 * is £125,140 or above." The engine does NOT taper from pay: HMRC issues
 * the tapered code itself, and the engine reads the code. These constants
 * document why high earners hold non-1257L codes.
 */
export const GB_2025_TAPER_START = "100000";
export const GB_2025_PERSONAL_ALLOWANCE_ZERO_AT = "125140";

/**
 * rUK bands in TAXABLE-pay space. Employer rates page: "Basic tax rate 20%
 * Up to £37,700", "Higher tax rate 40% From £37,701 to £125,140",
 * "Additional tax rate 45% Above £125,140". Wales prints the identical
 * table — and welsh-income-tax ("Rates and bands for 2025 to 2026": "These
 * rates have been set by the Welsh Government") prints the same bands in
 * gross space (basic £12,571 to £50,270 — 12,570 + 37,700 — higher £50,271
 * to £125,140, additional over £125,140), so Wales needs no separate
 * edition. The freeze is Autumn Statement 2022: "Income tax, National
 * Insurance and Inheritance Tax thresholds will be maintained at their
 * current levels for a further two years, to April 2028."
 */
export const GB_2025_RUK_BANDS: readonly GbRukBand[] = [
  { upTo: "37700", rate: "0.20" },
  { upTo: "125140", rate: "0.40" },
  { upTo: null, rate: "0.45" },
];

/**
 * Scottish bands in TAXABLE-pay space, transcribed from the employer rates
 * page's Scotland section: "Starter tax rate 19% Up to £2,827", "Basic tax
 * rate 20% From £2,828 to £14,921", "Intermediate tax rate 21% From £14,922
 * to £31,092", "Higher tax rate 42% From £31,093 to £62,430", "Advanced tax
 * rate 45% From £62,431 to £125,140", "Top tax rate 48% Above £125,140".
 *
 * Cross-check (gross-income space) from scottish-income-tax (June 2025
 * snapshot, "The table shows the 2025 to 2026 Scottish Income Tax rates"):
 * "£12,571 to £15,397 19%", "£15,398 to £27,491 20%", "£27,492 to £43,662
 * 21%", "£43,663 to £75,000 42%", "£75,001 to £125,140 45%", "over
 * £125,140 48%". Each top below the taper point is exactly £12,570 above
 * the taxable-space top (15,397 = 12,570 + 2,827; 27,491 = 12,570 + 14,921;
 * 43,662 = 12,570 + 31,092; 75,000 = 12,570 + 62,430) — the two pages
 * agree, so no Budget papers are needed. That page also states the shared
 * allowance facts: "a standard Personal Allowance of £12,570" and "You do
 * not get a Personal Allowance if you earn over £125,140".
 */
export const GB_2025_SCT_BANDS: readonly GbSctBand[] = [
  { upTo: "2827", rate: "0.19" },
  { upTo: "14921", rate: "0.20" },
  { upTo: "31092", rate: "0.21" },
  { upTo: "62430", rate: "0.42" },
  { upTo: "125140", rate: "0.45" },
  { upTo: null, rate: "0.48" },
];

/**
 * Category-A thresholds 2025/26. Employer rates page: "Lower earnings limit
 * £125 per week £542 per month £6,500 per year", "Primary threshold £242 per
 * week £1,048 per month £12,570 per year", "Secondary threshold £96 per week
 * £417 per month £5,000 per year", "Upper earnings limit £967 per week
 * £4,189 per month £50,270 per year".
 */
export const GB_2025_NIC_ANNUAL: GbNicThresholds = {
  lel: "6500",
  pt: "12570",
  st: "5000",
  uel: "50270",
};

export const GB_2025_NIC_WEEKLY: GbNicThresholds = {
  lel: "125",
  pt: "242",
  st: "96",
  uel: "967",
};

export const GB_2025_NIC_MONTHLY: GbNicThresholds = {
  lel: "542",
  pt: "1048",
  st: "417",
  uel: "4189",
};

/**
 * Employee (primary) category-A rates. Employer rates page: category letter
 * A — "0%" (LEL to PT), "8%" (above PT to UEL), "2%" (balance above UEL).
 */
export const GB_2025_NIC_EMPLOYEE_MAIN_RATE = "0.08";
export const GB_2025_NIC_EMPLOYEE_UPPER_RATE = "0.02";

/**
 * Employer (secondary) category-A rate. Employer rates page: category
 * letter A — "15%" on earnings above the secondary threshold (every
 * column). Autumn Budget 2024 raised this from 13.8% and cut the secondary
 * threshold from £9,100, both effective 6 April 2025.
 */
export const GB_2025_NIC_EMPLOYER_RATE = "0.15";

/**
 * Employment Allowance 2025/26: £10,500. Employer rates page: "Employment
 * Allowance ... £10,500" for 2025 to 2026 (raised from £5,000 with the
 * £100,000 cap removed, Autumn Budget 2024). Tenant-entered, never
 * computed: eligibility turns on employer facts no payroll table carries
 * (see rates.ts).
 */
export const GB_2025_EMPLOYMENT_ALLOWANCE_ANNUAL = "10500";

/**
 * Workplace-pension auto-enrolment 2025/26: trigger £10,000,
 * qualifying-earnings band £6,240–£50,270. DWP 2025/26 supporting analysis:
 * "She has concluded that the existing threshold of £10,000 for the
 * earnings trigger remains the correct level and will be maintained for
 * 2025/2026", "the value of the lower limit of the qualifying earnings band
 * for 2025/2026 will continue to be set at £6,240", "the value of the upper
 * limit ... for 2025/2026 will continue to be set at £50,270" (Table 1:
 * current and proposed identical). Declared so the band is on the record;
 * minimum contributions ride each employer's scheme, so there is no slot
 * and no engine.
 */
export const GB_2025_AE_TRIGGER_ANNUAL = "10000";
export const GB_2025_AE_QUALIFYING_BAND_LOWER = "6240";
export const GB_2025_AE_QUALIFYING_BAND_UPPER = "50270";
