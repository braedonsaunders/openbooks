/**
 * The AU payroll country pack — registered and installable.
 *
 * Declares what Australia withholds and accrues — PAYG withholding (which
 * collects income tax, the Medicare levy and STSL repayments through the one
 * withholding), the Superannuation Guarantee employer contribution, and
 * workers' compensation — plus the TFN declaration, the STP filing, and
 * named refusals for everything not yet transcribed.
 *
 * `installable: true` since FY 2026–27 transcribes Schedule 1 scales 1–3,
 * 5 and 6 (with and without the Schedule 8 STSL component) from the
 * registered instrument F2026L00716. Supported: TFN-quoted residents on
 * scales 1–2, foreign residents on scale 3, Medicare-exempt residents on
 * scales 5–6. Refused by name: scale 4 (no TFN), foreign-plus-exemption,
 * Schedule 15 (working holiday makers), every other schedule, and
 * non-standard pay frequencies — see AU_REFUSED_2027. `PayrollCountry` is the
 * registry's own keys, so `country: "AU"` typechecks directly.
 */
import type {
  PayrollCountryPack,
  PayrollRegionCoverage,
} from "../packs.ts";
import { AU_CERTIFICATES, AU_KNOWN_REGIONS, AU_WITHHOLDING } from "./jurisdictions.ts";
import { AU_FACTOR_LABELS, computeAuStatutory } from "./compute-statutory.ts";
import { applyAuEmployerLevies } from "./employer-levies.ts";
import { auPackFilings } from "./filings.ts";
import { AU_PACK_RATES, AU_TAX_YEARS } from "./rates.ts";

const AU_REGIONS: PayrollRegionCoverage = {
  label: "state",
  known: AU_KNOWN_REGIONS,
  // PAYG withholding is federal and uniform: the transcribed Schedule 1
  // scales apply identically in every state and territory, so every known
  // region is supported. No state publishes its own tables
  // (regionsWithOwnTables is [] in AU_TAX_YEARS).
  supported: [...AU_KNOWN_REGIONS],
  unsupportedReason:
    "PAYG withholding for {region} is not implemented by the AU payroll pack",
};

export const AU_PAYROLL_PACK: Omit<PayrollCountryPack, "country"> & { country: "AU" } = {
  country: "AU",
  name: "Australia",
  // ATO: a TFN is "a unique number (usually 9 digits)". Quoting it is
  // VOLUNTARY — "It is not an offence not to quote your TFN" — and an
  // employee without one is withheld at the top marginal rate instead, so
  // requiredForPayroll is false and the profile API saves an
  // identifier-less employee. neededFor is null: no filing demands it.
  employeeIdentifier: {
    label: "Tax File Number",
    pattern: "\\d{9}",
    formatHelp: "9 digits",
    example: "123456782",
    requiredForPayroll: false,
    neededFor: null,
    citation: "ATO: a TFN is 'a unique number (usually 9 digits)'; 'It is not an offence not to quote your TFN'",
    numericEntry: true,
  },
  installable: true,
  statutoryCurrency: "AUD",
  // The ATO financial year opens 1 July and is named for the year it closes
  // (2025–26 opens 1 July 2025). Data on the pack, not a code branch.
  taxYear: { basis: "fiscal", startMonth: 7, startDay: 1, namedBy: "closing_year" },
  regions: AU_REGIONS,
  // No employment calendar is declared yet: the Fair Work Act national public
  // holidays and the state calendars are not transcribed, and an empty list
  // refuses loudly where `null` would falsely claim no holiday-pay mandate.
  jurisdictions: [],
  // PAYG withholding is remitted to the ATO through the org-configured ATO
  // remittance vendor. (The ATO's own due-date timetable by withholding size
  // is not transcribed, so no schedule is declared.)
  remittanceVendorSettingsKey: "atoRemittancePartyId",
  // ATO arrears and lump-sum payments are taxed outside ordinary period
  // annualisation (lump sum payment in arrears treatment, Schedule 5 back
  // payments). Provisional: confirm against the transcribed schedules.
  retroactivePayTreatment: "non_periodic",
  contributoryBases: {
    // Super Guarantee is assessed on ordinary time earnings (12% from
    // 1 July 2025 — ATO).
    pensionable: "ordinary time earnings (OTE) — the Super Guarantee base",
    // No EI equivalent exists; the second accumulator carries wages
    // assessable for state workers' compensation insurance.
    insurable: "workers' compensation assessable wages (state schemes)",
  },
  // Union dues give PAYG withholding no per-period treatment (deductible on
  // the annual return only), so the engine stamps nothing.
  employeeUnionDuesTaxTreatment: null,
  deductionTreatments: [
    // Salary-sacrificed amounts reduce assessable income for PAYG
    // withholding, but NOT ordinary-time earnings for the superannuation
    // guarantee — so the declaration reduces the income leg only, the
    // generic layer hands the engine the reduced base, and SG prices the
    // untouched pensionable leg (see compute-statutory.ts).
    {
      key: "salary_sacrifice",
      label: "Salary sacrifice (PAYG)",
      help: "Pre-tax salary-sacrificed amount: reduces the PAYG withholding base, not the superannuation guarantee base.",
      reduces: ["income"],
    },
  ],
  filings: auPackFilings,
  statutoryRates: AU_PACK_RATES,
  taxYears: AU_TAX_YEARS,
  certificates: () => AU_CERTIFICATES,
  withholding: () => AU_WITHHOLDING,
  statutorySlots: [
    {
      key: "payg",
      components: [
        // PAYG withholding collects income tax, the Medicare levy and STSL
        // repayments through the one withholding, driven by the TFN
        // declaration answers. Salary-sacrificed amounts reduce its base via
        // the pack's `salary_sacrifice` deduction treatment: the generic
        // layer hands the engine income net of tagged lines
        // (`reducedBases.income`), so the line is re-derived by the
        // protection fixpoint like every income tax.
        { code: "PAYG", name: "PAYG withholding", systemKey: "payg_withholding", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "super",
      components: [
        // Super Guarantee: the employer contribution on ordinary time
        // earnings (12% from 1 July 2025). Paid to the employee's super
        // fund, never to the ATO — hence `external`, with the fund as the
        // per-component destination.
        { code: "SG", name: "Superannuation guarantee", systemKey: "super_guarantee", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "external" },
      ],
    },
    {
      key: "wcb",
      components: [
        // Workers' compensation premium: assessable wages × the employer's
        // state-insurer rate (a tenant-entered regional slot — see
        // AU_PACK_RATES), remitted to the state insurer. Consumed by
        // applyAuEmployerLevies (./employer-levies.ts), which prices the
        // stub's gross at the resolving regional fraction.
        { code: "WCB", name: "Workers' compensation", systemKey: "wcb", kind: "employer_contribution", sequence: 260, assessedOn: "earnings", remittance: "external" },
      ],
    },
  ],
  applyEmployerLevies: applyAuEmployerLevies,
  computeStatutory: computeAuStatutory,
  statutoryEngineLabel: "PAYG withholding",
  factorLabels: { ...AU_FACTOR_LABELS },
};
