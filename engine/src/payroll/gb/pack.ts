/**
 * The GB payroll country pack — registered on `PAYROLL_COUNTRY_PACKS`.
 *
 * `PayrollCountry` is the registry's own keys, so no country list needs
 * widening by hand. The property this module kept while the union was closed
 * still holds and is worth keeping: no `as PayrollCountry` cast, and no
 * `=== "GB"` anywhere outside `engine/src/payroll/gb/`.
 *
 * What the pack declares:
 * - statutory slots: PAYE income tax, Class 1 NIC employee (primary) and
 *   employer (secondary), computed end to end for 2026/27, 2025/26 and
 *   2024/25 — each year from its own transcribed tables (year-tables.ts). Student-loan /
 *   postgraduate-loan and workplace pension are REFUSED by name (see
 *   jurisdictions.ts header): no slot, no engine. The Employment Allowance
 *   (£10,500) is tenant-entered, never computed (conditional eligibility).
 * - fiscal tax year opening 6 April, named for the opening year (2026/27).
 * - four nations, four supported: ENG/WLS/NIR share the rUK bands and SCT
 *   prices its own starter..top bands through the SCT edition (GB_SCT_BANDS),
 *   selected by the S-prefix code — never by falling an S-less code through
 *   to rUK (see compute-statutory.ts). NIC stays UK-wide for all four.
 * - starter checklist + P6/P9 coding-notice certificates (not a W-4 clone):
 *   the tax code rides the notice and the engine operates it — 1257L/S1257L
 *   cumulative, W1/M1/X period-only, BR/D0/D1 and SBR/SD0–SD3 flat, 0T/NT,
 *   K with its 50% cap — refusing every other code by name (see tax-codes.ts).
 * - `installable: true`: the 2026/27 rUK and SCT editions are transcribed,
 *   the engine reads them, and the parity harnesses (parity.test.ts,
 *   parity-scotland.test.ts) prove them to the penny against HMRC's own
 *   worked examples.
 *
 * Wiring checklist for Orchestrate (one entry, no other file changes):
 *   1. Open `PayrollCountry` (packs.ts:190) to the registry keys.
 *   2. Add `GB: GB_PACK` to `PAYROLL_COUNTRY_PACKS`.
 * Everything else — certificates, withholding, filings, rates, tax years —
 * is already read through the pack registry by generic code.
 */

import type {
  PayrollCountryPack,
  PayrollStatutorySlot,
} from "../packs.ts";
import { computeGbStatutory, GB_FACTOR_LABELS } from "./compute-statutory.ts";
import { gbPackFilings } from "./filings.ts";
import { GB_EMPLOYEE_FACTS } from "./employee-facts.ts";
import {
  GB_CERTIFICATES,
  GB_REGIONS,
  GB_WITHHOLDING,
} from "./jurisdictions.ts";
import { GB_NATIONS, GB_PACK_RATES, GB_TAX_YEARS } from "./rates.ts";

/** The GB pack's registry key, once `PayrollCountry` opens to it. */
export const GB_COUNTRY_CODE = "GB" as const;

/** The nations the GB pack knows, re-exported for the wiring diff. */
export const GB_KNOWN_NATIONS: readonly string[] = [...GB_NATIONS];

/**
 * The GB pack's statutory slots: every levy the jurisdiction withholds or
 * accrues that this pack implements.
 *
 * PAYE is assessed on taxable income (pre-tax pension contributions move it,
 * so the deduction-protection fixpoint must re-derive it — the same
 * `taxable_income` class as T4127 factor T and US FIT). Both NIC shares are
 * assessed on NIC-able earnings, which no deduction reduces: `earnings`, like
 * employee CPP/EI and employer FICA.
 *
 * PAYE remits as `tax_authority`; the pack declares
 * `remittanceVendorSettingsKey: null` (PAYE/NIC go to the HMRC Accounts
 * Office quoted on the employer's PAYE reference, not to an org-wide vendor
 * row this pack establishes), so both shares surface unassigned until a
 * destination is configured — the same treatment as the US pack's EFTPS
 * deposits. No student-loan or pension slot: refused, not forgotten.
 */
export const GB_STATUTORY_SLOTS: readonly PayrollStatutorySlot[] = [
  {
    key: "paye",
    // Withheld PAYE sits in the chart's payroll-deductions account: the pack
    // names the ROLE and the chart resolves it (2110 here, 2300 there) —
    // never an account number in pack code, and never the vendor-payable
    // family a subcontractor balance belongs to.
    liabilityAccountRole: "payrollDeductions",
    components: [
      {
        code: "PAYE",
        name: "PAYE income tax",
        systemKey: "paye",
        kind: "deduction",
        sequence: 110,
        assessedOn: "taxable_income",
        remittance: "tax_authority",
      },
    ],
  },
  {
    key: "nic",
    // Both NIC shares remit to HMRC with the PAYE, so both ride the same
    // payroll-deductions account as the income tax they are paid with.
    liabilityAccountRole: "payrollDeductions",
    components: [
      {
        code: "NIC-EE",
        name: "National Insurance (employee, primary)",
        systemKey: "nic",
        kind: "deduction",
        sequence: 120,
        assessedOn: "earnings",
        remittance: "tax_authority",
      },
      {
        code: "NIC-ER",
        name: "National Insurance (employer, secondary)",
        systemKey: "nic",
        kind: "employer_contribution",
        sequence: 210,
        assessedOn: "earnings",
        remittance: "tax_authority",
      },
    ],
  },
];

/**
 * The complete GB pack. Typed as the pack interface with ONLY the `country`
 * member opened to the GB literal — every other member is checked against
 * `PayrollCountryPack` exactly, so the wiring diff is the union plus one
 * registry line and nothing here changes shape when it lands.
 */
export const GB_PACK: Omit<PayrollCountryPack, "country"> & {
  country: typeof GB_COUNTRY_CODE;
} = {
  country: GB_COUNTRY_CODE,
  name: "United Kingdom",
  // HMRC National Insurance Manual NIM39110: "A NINO is made up of 2
  // letters, 6 numbers and a final letter, which is always A, B, C, or D"
  // (e.g. "QQ 12 34 56 A" — HMRC's own example, illustrative only, so QQ
  // prefixes validate). Spaced and unspaced presentations both validate as
  // given. Prefix exclusions are NOT enforced — the wrong rejection is the
  // defect — and there is no checksum to enforce. Needed for RTI (the FPS
  // carries the NINO), including while the RTI filing itself is refused.
  employeeIdentifier: {
    label: "National Insurance number",
    pattern: "[A-Z]{2}( ?\\d{2}){3} ?[A-D]",
    formatHelp: "2 letters, 6 digits, 1 letter A–D",
    example: "QQ 12 34 56 C",
    requiredForPayroll: true,
    neededFor: "RTI",
    citation: "HMRC NIM39110: 'A NINO is made up of 2 letters, 6 numbers and a final letter, which is always A, B, C, or D'",
    numericEntry: false,
  },
  // 2024/25, 2025/26 and 2026/27 rUK + SCT editions transcribed
  // (GB_TAX_YEARS), engine behind all three, parity harnesses green:
  // installable.
  installable: true,
  statutorySlots: GB_STATUTORY_SLOTS,
  // PAYE and NIC are remitted to the HMRC Accounts Office on the employer's
  // PAYE reference — no single org-configured statutory vendor exists the way
  // the CRA remittance vendor does, so withholdings surface unassigned until
  // per-component destinations are set (the US pack's EFTPS answer).
  remittanceVendorSettingsKey: null,
  remittanceRegionalCalendars: {},
  // PAYE has no supplemental-wages method: arrears, bonuses and back pay are
  // taxed as ordinary pay of the period they are PAID in (reported on time via
  // RTI), so a retro amount annualizes with the period like any other pay.
  // Inert while installable:false — declared because the field is REQUIRED,
  // not because an engine reads it yet.
  retroactivePayTreatment: "periodic",
  contributoryBases: {
    pensionable: "Class 1 National Insurance-able earnings (primary and secondary)",
    insurable:
      "unused by the GB pack: Class 1 NIC is the only earnings-assessed levy and it reads "
      + "pensionable; no second NIC-style base exists and the student-loan/pension tables "
      + "are untranscribed",
  },
  // PAYE gives employee-paid union dues no T4127-U1-style deduction from
  // taxable pay.
  employeeUnionDuesTaxTreatment: null,
  deductionTreatments: [
    // Net-pay-arrangement pension contributions reduce taxable pay for PAYE
    // (period pay prices income plus bonuses less pension) but NOT
    // NIC-able earnings — so only `income` is named, and the engine keeps
    // subtracting via `deduction()` exactly as before.
    // The label names the pack's own instrument: the shared catalog key
    // (options.payTaxTreatment.pensionF) carries the Canadian factor name,
    // so the GB treatment states its own English label and no labelKey.
    {
      key: "pension_f",
      label: "Pension (net-pay arrangement)",
      help: "Workplace pension (net-pay arrangement): reduces PAYE taxable pay, not National Insurance earnings.",
      reduces: ["income"],
    },
  ],
  statutoryCurrency: "GBP",
  // HMRC's year opens 6 April and is named for the year it opens (2026/27).
  taxYear: { basis: "fiscal", startMonth: 4, startDay: 6, namedBy: "opening_year" },
  regions: GB_REGIONS,
  // No employment-standards calendars transcribed: the UK mandates paid
  // statutory leave (Working Time Regulations), so `holidayPay: null` would be
  // false and an undeclared nation refused by name is the honest answer.
  jurisdictions: [],
  filings: gbPackFilings,
  statutoryRates: GB_PACK_RATES,
  taxYears: GB_TAX_YEARS,
  certificates: () => GB_CERTIFICATES,
  withholding: () => GB_WITHHOLDING,
  // No reciprocity declaration: the four nations have no inter-nation
  // withholding agreements (Scottish-taxpayer status follows the employee's
  // residence via the S-prefixed code, not the work nation), and absent says
  // exactly that — like Canada.
  computeStatutory: computeGbStatutory,
  statutoryEngineLabel: "PAYE",
  factorLabels: { ...GB_FACTOR_LABELS },
  // No `emp` facts: the engine reads the tax code and student-loan flags
  // off the certificate answers, never off bare profile keys.
  employeeFacts: GB_EMPLOYEE_FACTS,
  employerFacts: [],
};
