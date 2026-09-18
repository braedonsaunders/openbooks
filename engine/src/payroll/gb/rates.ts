/**
 * GB payroll pack rate declarations: which tax years are transcribed, and which
 * statutory rates are tenant-entered.
 *
 * NOTHING IS TRANSCRIBED HERE. The 2026/27 HMRC tables exist — HMRC published
 * "Rates and thresholds for employers 2026 to 2027" on 30 January 2026 (last
 * updated 1 September 2026) — but transcribing them means transcribing them
 * like a US state engine: the band tables, the Class 1 primary/secondary
 * thresholds and rates, the engine that reads them, and the conformance
 * goldens that prove the engine. A table of numbers with no engine behind it
 * is silent wrong money, so until that pass happens every year is refused by
 * name and the pack is not installable.
 *
 * Sources located (fetched September 2026, transcribed nowhere):
 * - PAYE + Class 1 NIC tables for employers, 2026/27:
 *   https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027
 * - rUK PAYE bands and the frozen Personal Allowance (£12,570) to April 2028:
 *   https://www.gov.uk/government/publications/the-personal-allowance-and-basic-rate-limit-for-income-tax-and-certain-national-insurance-contributions-nics-thresholds-from-6-april-2026-to-5-apr/income-tax-personal-allowance-and-the-basic-rate-limit-and-certain-national-insurance-contributionsthresholds-from-6-april-2026-to-5-april-2028
 * - Scottish bands 2026/27 (19/20/21/42/45/48%): the canonical HMRC page
 *   https://www.gov.uk/scottish-income-tax still prints the 2025/26 thresholds
 *   (£15,397/£27,491), so the 2026/27 figures (£16,537/£29,526 starter/basic
 *   tops) are known only from the Scottish Budget 2026/27 resolution papers and
 *   secondary reporting — a second reason to refuse rather than transcribe.
 * - Student-loan / postgraduate-loan plan thresholds from April 2026:
 *   https://www.gov.uk/guidance/special-rules-for-student-loans
 * - Auto-enrolment trigger and qualifying-earnings band 2026/27:
 *   https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627
 *
 * Region codes are ISO 3166-2:GB: ENG (England), SCT (Scotland), WLS (Wales),
 * NIR (Northern Ireland). Scotland is in `regionsWithOwnTables` because the
 * Scottish Parliament sets its own bands on non-savings income under the
 * Scotland Act 1998 — a GB year is loaded only when a published edition naming
 * SCT exists alongside the rUK tables, exactly like Quebec's TP-1015.
 */

import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollTaxYearSupport } from "../tax-years.ts";

/** The four nations, as ISO 3166-2:GB spells them. */
export const GB_NATIONS = ["ENG", "SCT", "WLS", "NIR"] as const;

/** A GB nation code. */
export type GbNation = (typeof GB_NATIONS)[number];

/**
 * Tax-year support: no transcribed editions. `editions: []` is a declaration
 * that the 2026/27 tables above have been LOCATED but not transcribed — every
 * consumer (readiness, setup surface, year-end enumeration, the statutory
 * engine) refuses the year by name instead of calculating from placeholders.
 */
export const GB_TAX_YEARS: PayrollTaxYearSupport = {
  country: "GB",
  editions: [],
  regionsWithOwnTables: ["SCT"],
  ratesModule: "engine/src/payroll/gb/rates.ts",
  scaffold: {
    files: [],
    barrels: [],
    steps: [
      "Transcribe the rUK PAYE bands and the Scottish bands from "
        + "https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 "
        + "into engine/src/payroll/gb/ (one edition per HMRC publication, Scotland as its own edition).",
      "Transcribe the Class 1 primary/secondary thresholds and rates from the same publication.",
      "Build the PAYE/NIC engine in engine/src/payroll/gb/ with conformance goldens, like a US state engine.",
      "Add the published edition(s) to GB_TAX_YEARS.editions and set installable: true on the GB pack.",
    ],
  },
};

/**
 * Tenant-entered statutory rates: none established. Employer NIC reliefs
 * (Employment Allowance, Freeport/Investment Zone/veterans secondary
 * thresholds) are employer- and account-specific, so their scope cannot be
 * declared until the engine that reads them exists. An empty slot list says
 * "no tenant-entered rate" rather than inheriting another pack's.
 */
export const GB_PACK_RATES: PayrollPackRates = {
  country: "GB",
  slots: [],
};
