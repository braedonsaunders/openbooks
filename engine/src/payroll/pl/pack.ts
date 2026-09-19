/**
 * The Poland payroll pack (`installable: true` — 2026 computes end to end
 * and the adapter golden pushes all ten lines through the
 * declaration-enforcing push path).
 *
 * Declares the monthly PIT advance (KAS) and standard ZUS employee +
 * employer contributions with NFZ zdrowotna and the FP/FS/FGŚP employer
 * funds as statutory slots, the PIT-2 certificate (reduction statement +
 * KUP variant), the single national region, and the Polish holiday
 * calendar. Calendar 2026 is transcribed — the PIT skala and advance
 * rules, the ZUS rates and split, the 282 600 zł annual base limit, the
 * 2026 fund rates and the minimum wage live in ./tables-2026.ts and
 * computeStatutory prices a monthly PIT-2-filed employment payslip
 * through them.
 *
 * Two authorities share the money — KAS (urząd skarbowy) takes the PIT
 * advances, ZUS takes the contributions — so no single statutory vendor is
 * named (`remittanceVendorSettingsKey: null`); `tax_authority` withholdings
 * surface unassigned until configured, as with the FR and US packs.
 */
import type { PayrollCountryPack } from "../packs.ts";
import type { PayrollPackRates } from "../statutory-rates.ts";
import { PL_CERTIFICATES } from "./certificates.ts";
import { computePlStatutory } from "./compute-statutory.ts";
import { plPackFilings } from "./filings.ts";
import { PL_JURISDICTIONS } from "./jurisdictions.ts";
import { PL_TAX_YEARS } from "./rates.ts";
import { PL_WITHHOLDING } from "./withholding.ts";

// ---------------------------------------------------------------------------
// Regions: PIT advances and ZUS contributions are both national — no
// voivodeship levies its own income tax — so the one known region is the
// country itself, and it is supported now that the monthly payslip computes
// end to end. Per-employee gaps (under-26, the FP 55–60 band,
// non-employment titles) refuse by name off the certificate and birth year.
// ---------------------------------------------------------------------------

const PL_REGIONS: PayrollCountryPack["regions"] = {
  label: "country",
  known: ["PL"],
  supported: ["PL"],
  unsupportedReason:
    "income tax withholding for {region} is not implemented: the monthly PIT advance does not compute end to end. "
    + "Transcribe the year's tables into engine/src/payroll/pl/ first.",
};

// ---------------------------------------------------------------------------
// Statutory slots. Named buckets only — no rates live here.
// ---------------------------------------------------------------------------

const PL_SLOTS: PayrollCountryPack["statutorySlots"] = [
  {
    key: "pit",
    components: [
      // Art. 32 updof: the advance is 12 %/32 % of the month's dochód
      // (revenue minus KUP minus employee social contributions), so a
      // pre-tax deduction moves it — re-derived by the fixpoint like T4127
      // factor T.
      { code: "PIT", name: "Zaliczka na podatek dochodowy (PIT)", systemKey: "pit", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
    ],
  },
  {
    key: "zus_ee",
    components: [
      // Employee social contributions collected by ZUS: emerytalne and
      // rentowe on the capped base, chorobowe on the full revenue.
      // Rate × base — deductions do not enter.
      { code: "EMERYT", name: "Składka emerytalna (pracownik)", systemKey: "zus_emeryt", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "RENT", name: "Składka rentowa (pracownik)", systemKey: "zus_rent", kind: "deduction", sequence: 121, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "CHOR", name: "Składka chorobowa (pracownik)", systemKey: "zus_chor", kind: "deduction", sequence: 122, assessedOn: "earnings", remittance: "tax_authority" },
    ],
  },
  {
    key: "zus_zdr",
    components: [
      // NFZ zdrowotna: 9 % of revenue minus the employee's social
      // contributions, uncapped. The abated base is built first (art. 81
      // ust. 6) — never rate × brutto.
      { code: "ZDR", name: "Składka zdrowotna (NFZ)", systemKey: "zus_zdr", kind: "deduction", sequence: 123, assessedOn: "earnings", remittance: "tax_authority" },
    ],
  },
  {
    key: "zus_er",
    components: [
      // Employer social contributions collected by ZUS: emerytalne and
      // rentowe on the capped base; wypadkowe on the full revenue at the
      // tenant-declared rate (no pack channel carries it, so the adapter
      // pushes no wypadkowe line — the component is declared so the slot
      // owns the rate when a channel lands).
      { code: "EMERYT-ER", name: "Składka emerytalna (pracodawca)", systemKey: "zus_emeryt_er", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "RENT-ER", name: "Składka rentowa (pracodawca)", systemKey: "zus_rent_er", kind: "employer_contribution", sequence: 211, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "WYP-ER", name: "Składka wypadkowa (pracodawca)", systemKey: "wypadkowe_er", kind: "employer_contribution", sequence: 215, assessedOn: "earnings", remittance: "tax_authority" },
    ],
  },
  {
    key: "fundusze_er",
    components: [
      // Employer labour funds collected via ZUS on the uncapped base: FP
      // and FS at/above the minimum wage with the age bar, FGŚP always.
      // Rate × base; deductions do not enter.
      { code: "FP-ER", name: "Fundusz Pracy (pracodawca)", systemKey: "fp_er", kind: "employer_contribution", sequence: 212, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "FS-ER", name: "Fundusz Solidarnościowy (pracodawca)", systemKey: "fs_er", kind: "employer_contribution", sequence: 213, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "FGSP-ER", name: "FGŚP (pracodawca)", systemKey: "fgsp_er", kind: "employer_contribution", sequence: 214, assessedOn: "earnings", remittance: "tax_authority" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Employer-entered rates: wypadkowe, notified per payer.
// ---------------------------------------------------------------------------

const PL_RATES: PayrollPackRates = {
  country: "PL",
  slots: [
    {
      key: "pl_wypadkowe",
      label: "Stopa wypadkowa",
      // Per payer: the rate follows the employer's PKD risk category
      // (small payers) or ZUS notification (larger payers) for the rok
      // składkowy — one rate per employer entity, never a published table.
      scope: "org",
      systemKeys: ["wypadkowe_er"],
      regions: ["PL"],
      citation:
        "Ustawa o systemie ubezpieczeń społecznych, art. 22 ust. 2 (różnicowanie stopy wypadkowej); "
        + "ZUS, Ustalanie stopy procentowej składki na ubezpieczenie wypadkowe (stan prawny 1 stycznia 2026)",
      variesBecause:
        "ZUS sets each payer its own wypadkowe rate from its activity risk category and claims record — a figure no published table can supply.",
      fields: [
        {
          key: "stopa", label: "Stopa wypadkowa (%)", kind: "percent", decimals: 4,
          min: "0", max: "100", required: true,
          help: "As a percent, as notified for this payer for the rok składkowy: 1.67 is 1.67%.",
        },
      ],
    },
  ],
};

export const PL_PAYROLL_PACK: PayrollCountryPack = {
  country: "PL",
  name: "Poland",
  installable: true,
  statutorySlots: PL_SLOTS,
  statutoryCurrency: "PLN",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: PL_REGIONS,
  jurisdictions: PL_JURISDICTIONS,
  // KAS takes the PIT advances (via PIT-4R/PIT-11), ZUS takes the
  // contributions (via DRA) — no single statutory vendor is named.
  remittanceVendorSettingsKey: null,
  // Zaliczki are computed on each month's paid revenue with no
  // annualization: exceptional payments join the month's base, and the
  // 120 000 zł test runs on year-to-date dochód — taxed as ordinary income
  // of the period paid (art. 32).
  retroactivePayTreatment: "periodic",
  contributoryBases: {
    pensionable: "Podstawa wymiaru składek na ubezpieczenia emerytalne i rentowe (capped at the 282 600 zł annual limit)",
    // No employee contribution in this pack is assessed on a separate
    // insurable base: chorobowe, wypadkowe and zdrowotna all price the same
    // revenue (chorobowe/wypadkowe uncapped, zdrowotna abated) — so the flag
    // accumulates nothing here rather than inheriting another
    // jurisdiction's EI/FUTA meaning.
    insurable: "unused — no employee-paid contribution is assessed on a separate insurable base",
  },
  // Union dues open an annual PIT deduction on the zeznanie, not a
  // reduction of the monthly advance (art. 32 ust. 4 lists only KUP and
  // social contributions) — the statutory engine gives dues no treatment.
  employeeUnionDuesTaxTreatment: null,
  filings: () => plPackFilings(),
  statutoryRates: PL_RATES,
  taxYears: PL_TAX_YEARS,
  certificates: () => PL_CERTIFICATES,
  withholding: () => PL_WITHHOLDING,
  computeStatutory: computePlStatutory,
  statutoryEngineLabel: "PIT/ZUS",
};
