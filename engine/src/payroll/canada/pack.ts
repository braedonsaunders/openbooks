import type {
  PayrollCountryPack,
  PayrollRegionCoverage,
} from "../packs.ts";
import { CA_COMPUTE_FACTOR_LABELS, computeCaStatutory } from "./compute-statutory.ts";
import { T4127_FACTOR_LABELS } from "./t4127.ts";
import { TP1015_FACTOR_LABELS } from "./quebec/tp1015.ts";
import { CRA_REMITTANCE_SCHEDULE } from "./cra/remittance.ts";
import { applyCaEmployerLevies } from "./employer-levies.ts";
import { CA_JURISDICTIONS } from "./employment-standards.ts";
import { caPackFilings } from "./filings.ts";
import { CA_CERTIFICATES, CA_WITHHOLDING_JURISDICTIONS, PROVINCE_NAMES } from "./jurisdictions.ts";
import { CA_OPENING_YTD_FIELDS } from "./opening-ytd.ts";
import { RQ_REMITTANCE_SCHEDULE } from "./quebec/remittance.ts";
import { CA_PACK_RATES, CA_TAX_YEARS, type Province } from "./rates.ts";
import { CA_EMPLOYEE_FACTS } from "./employee-facts.ts";
// HR-13: the CA pack's construction carve-outs (data, beside the pack).
import { CA_CONSTRUCTION } from "./construction.ts";

/**
 * The Canada payroll country pack — registered and installable.
 *
 * T4127 for the federal side (with the Quebec abatement, QPP and QPIP) plus
 * ./quebec for TP-1015 provincial income tax and the RL-1; the CRA and Revenu
 * Québec remittance schedules; the TD1 certificates; and the provincial
 * employment-standards jurisdictions.
 *
 * This pack and the US one were object literals inside `../packs.ts` until the
 * registry was made uniform. They were written before a second country existed,
 * so the registry file and the pack declaration were the same file — which left
 * the two oldest and most complete packs as the two hardest to find, and the
 * only two that pack-level structural tests could not read. Every other pack is
 * a module with one import line in the registry, and now so is this. The
 * extraction was behaviour-preserving: same object, same key order, same values,
 * with `CALENDAR_TAX_YEAR` inlined the way every other pack declares it.
 */

/** Every T4127 province code, plus ZZ (employed outside any province). */
const CA_PROVINCES: readonly Province[] = [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT", "ZZ",
];

const CA_REGIONS: PayrollRegionCoverage = {
  label: "province",
  known: CA_PROVINCES,
  regionNames: PROVINCE_NAMES,
  // Every province including Quebec: T4127 computes the federal side (with
  // the abatement, QPP, QPIP) and engine/src/payroll/canada/quebec computes
  // TP-1015 provincial income tax; the RL-1 registers onto the CA year-end
  // filings from the same tree.
  supported: CA_PROVINCES,
  unsupportedReason:
    "provincial income tax withholding for {region} is not implemented by the CA payroll pack",
};

export const CA_PAYROLL_PACK: PayrollCountryPack = {
  country: "CA",
  name: "Canada",
  // CRA (canada.ca, payroll: "Get the social insurance number (SIN) from
  // the individual"): "Employees must obtain and provide to their employer
  // the 9-digit number known as a social insurance number (SIN) when
  // starting employment in Canada." Needed for the T4 (and RL-1) slips.
  employeeIdentifier: {
    label: "SIN",
    pattern: "\\d{9}",
    formatHelp: "9 digits",
    example: "046454286",
    requiredForPayroll: true,
    neededFor: "T4/RL-1",
    citation: "CRA: the SIN is 'the 9-digit number known as a social insurance number (SIN)' (Service Canada issues it)",
    numericEntry: true,
  },
  installable: true,
  // T4127 produces CAD; the CRA's tax year is the calendar year.
  statutoryCurrency: "CAD",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: CA_REGIONS,
  jurisdictions: CA_JURISDICTIONS,
  // Source deductions are remitted to the Receiver General through the
  // org-configured CRA remittance vendor.
  remittanceVendorSettingsKey: "craRemittancePartyId",
  // The CRA keeps a separate Québec public-holiday calendar: Saint-Jean-Baptiste
  // Day is a holiday there and the Civic Holiday is not, so a Québec-only
  // payroll's remittance deadline moves differently from the rest of Canada's.
  remittanceRegionalCalendars: { QC: "CA-CRA-QC" },
  // Québec-source amounts remit to Revenu Québec on TPZ-1015.R, on Revenu
  // Québec's own frequencies — never on the CRA schedule below. See
  // engine/src/payroll/canada/quebec/remittance.ts for the transcribed rules.
  // The CRA timetable itself is declared data too (same shape, same channel):
  // engine/src/payroll/canada/cra/remittance.ts transcribes the CRA's "When
  // to remit (pay)" table for the `craRemittancePartyId` destination, so a
  // CRA bill dates from the schedule in force the way an RQ bill already does.
  remittanceSchedules: [RQ_REMITTANCE_SCHEDULE, CRA_REMITTANCE_SCHEDULE],
  // T4127 Method 2 ("retroactive pay increase") taxes a retro amount as a
  // BONUS, not as period income — the CRA's own instruction — and Revenu
  // Québec's TP-1015 Appendix 2 says the same for the provincial side. Both
  // are already implemented and conformance-tested as the non-periodic
  // (factor B) path, so this declaration wires retro to that engine rather
  // than to anything new.
  retroactivePayTreatment: "non_periodic",
  contributoryBases: {
    pensionable: "CPP/QPP pensionable earnings (T4127 factor PI)",
    insurable: "EI insurable earnings (T4127 factor IE)",
  },
  // T4127 factor U1: employee-paid dues reduce taxable income.
  employeeUnionDuesTaxTreatment: "union_dues",
  deductionTreatments: [
    // T4127 factors F (RPP/RRSP pension), U1 (union dues) and F2 (alimony):
    // each reduces the periodic income leg — annual taxable income A prices
    // (income − F − F2 − U1) × P, while bonuses carry their own F3/F4
    // factors. None reduces CPP/QPP, EI or QPIP, so only `income` is named.
    {
      key: "pension_f",
      label: "Pension (RPP/RRSP, factor F)",
      labelKey: "options.payTaxTreatment.pensionF",
      help: "RPP/RRSP contributions (T4127 factor F): reduce income-taxable income, not CPP/QPP or EI.",
      reduces: ["income"],
    },
    {
      key: "union_dues",
      label: "Union dues (U1)",
      labelKey: "options.payTaxTreatment.unionDues",
      help: "Union dues (T4127 factor U1): reduce income-taxable income, not CPP/QPP or EI.",
      reduces: ["income"],
    },
    {
      key: "alimony",
      label: "Alimony (F2)",
      labelKey: "options.payTaxTreatment.alimony",
      help: "Support payments (T4127 factor F2): reduce income-taxable income, not CPP/QPP or EI.",
      reduces: ["income"],
    },
  ],
  filings: caPackFilings,
  statutoryRates: CA_PACK_RATES,
  taxYears: CA_TAX_YEARS,
  certificates: () => CA_CERTIFICATES,
  withholding: () => CA_WITHHOLDING_JURISDICTIONS,
  // Bonus-attributed CPP2 (F5B) and additional-QPP (CSB1) history the T4127
  // and TP-1015 bonus methods read for a mid-year adopter.
  openingYtdFields: () => CA_OPENING_YTD_FIELDS,
  // No member at all: Canada's provinces have no interprovincial withholding
  // agreements, and an absent declaration says exactly that. See
  // engine/src/payroll/canada/jurisdictions.ts.
  statutorySlots: [
    {
      key: "income_tax",
      legacySettingsKey: "taxPayableAccountId",
      components: [
        // T4127 factor T: annual taxable income A is income LESS the
        // factor-F / F2 / U1 deductions, so a pre-tax protected order moves
        // it. The only Canadian line the fixpoint re-derives.
        { code: "TAX", name: "Income tax", systemKey: "income_tax", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "qc_income_tax",
      // Québec employment only: outside QC the slot is inert — no line, no
      // account demand — so an Ontario employer is never asked to map it.
      regions: ["QC"],
      components: [
        // TP-1015 variable A: annual taxable income I is income LESS the
        // factor-F / H / CSA deductions, so a pre-tax protected order moves
        // it — re-derived by the fixpoint exactly like federal income_tax.
        //
        // remittance is "external", NOT "tax_authority": Québec source
        // deductions are remitted to Revenu Québec (form TPZ-1015.R), a
        // different agency from the CRA vendor the pack's
        // remittanceVendorSettingsKey names. The org configures its Revenu
        // Québec vendor on this component's remittance_party_id — that
        // difference in destination is the entire reason this is a second
        // slot and not part of income_tax.
        { code: "QCTAX", name: "Québec income tax", systemKey: "qc_income_tax", kind: "deduction", sequence: 115, assessedOn: "taxable_income", remittance: "external" },
      ],
    },
    {
      key: "cpp",
      legacySettingsKey: "cppPayableAccountId",
      components: [
        // C and C2 are rate × (pensionable income − exemption), capped on
        // YTD contributions. No deduction enters the formula.
        //
        // For a QC employee the same slot IS the QPP: T4127 computes QPP
        // under the C/C2 factors and the run pushes the same system keys.
        // QPP is remitted to Revenu Québec on TPZ-1015.R, not to the CRA —
        // the regional declaration routes the QC share there.
        { code: "CPP", name: "CPP", systemKey: "cpp", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
        { code: "CPP2", name: "CPP (second additional)", systemKey: "cpp2", kind: "deduction", sequence: 130, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
        { code: "CPP-ER", name: "CPP (employer)", systemKey: "cpp", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
      ],
    },
    {
      key: "ei",
      legacySettingsKey: "eiPayableAccountId",
      components: [
        // EI is rate × insurable earnings; the employer share is a multiple
        // of the employee's. EI is FEDERAL for every province including
        // Quebec — no regional override; it always goes to the CRA vendor.
        { code: "EI", name: "EI", systemKey: "ei", kind: "deduction", sequence: 140, assessedOn: "earnings", remittance: "tax_authority" },
        { code: "EI-ER", name: "EI (employer)", systemKey: "ei", kind: "employer_contribution", sequence: 220, assessedOn: "earnings", remittance: "tax_authority" },
      ],
    },
    {
      key: "qpip",
      legacySettingsKey: "eiPayableAccountId",
      // Québec employment only — inert elsewhere, like qc_income_tax above.
      regions: ["QC"],
      components: [
        // QPIP exists only for QC employment, and it is remitted to Revenu
        // Québec on TPZ-1015.R — declared per region for the same reason as
        // QPP, so the declaration stays on the component, not in the
        // remittance module.
        { code: "QPIP", name: "QPIP", systemKey: "qpip", kind: "deduction", sequence: 150, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
        { code: "QPIP-ER", name: "QPIP (employer)", systemKey: "qpip", kind: "employer_contribution", sequence: 230, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
      ],
    },
    {
      key: "vacation",
      legacySettingsKey: "vacationPayableAccountId",
      components: [
        // A percentage of vacationable EARNINGS (the entitlement engine
        // emits it, phase 7), never of anything net of a deduction.
        { code: "VAC", name: "Vacation accrual", systemKey: "vacation_accrual", kind: "employer_contribution", sequence: 240, assessedOn: "earnings", remittance: "internal_accrual" },
      ],
    },
    {
      key: "wcb",
      components: [
        // Assessable earnings × the worker-comp group's rate, job-split
        // proportional to the earnings it assesses.
        { code: "WCB", name: "Workers' compensation (WCB/WSIB)", systemKey: "wcb", kind: "employer_contribution", sequence: 260, assessedOn: "earnings", remittance: "external" },
      ],
    },
    {
      key: "eht",
      // The four levying provinces, mirroring the ca_eht rate slot: an
      // employer with payroll nowhere near them is never asked to map it.
      regions: ["BC", "MB", "NL", "ON"],
      components: [
        // Ontario remuneration past the annual exemption — remuneration is
        // an earnings measure.
        { code: "EHT", name: "Employer Health Tax", systemKey: "eht", kind: "employer_contribution", sequence: 270, assessedOn: "earnings", remittance: "external" },
      ],
    },
    {
      key: "hsf",
      // Québec employment only, mirroring the ca_hsf rate slot: inert
      // elsewhere — no line, no account demand.
      regions: ["QC"],
      components: [
        // TP-1015.F-V s. 5: the tenant-entered HSF rate times the
        // remuneration subject (employment income is generally subject —
        // an earnings measure, no exemption, no cap). QC employment only,
        // remitted to Revenu Québec on TPZ-1015.R like QPP/QPIP — declared
        // per region for the same reason, so the declaration stays on the
        // component, not in the remittance module.
        { code: "HSF", name: "Health Services Fund", systemKey: "hsf", kind: "employer_contribution", sequence: 280, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
      ],
    },
  ],
  applyEmployerLevies: applyCaEmployerLevies,
  computeStatutory: computeCaStatutory,
  statutoryEngineLabel: "T4127",
  // Pack-declared trace labels, aggregated from the modules that trace
  // them: T4127, TP-1015 (QC_-prefixed final keys), and the compute pass's
  // own inputs and employer-levy factors.
  factorLabels: {
    ...T4127_FACTOR_LABELS,
    ...TP1015_FACTOR_LABELS,
    ...CA_COMPUTE_FACTOR_LABELS,
  },
  employeeFacts: CA_EMPLOYEE_FACTS,
  // HR-13: construction carve-outs as pack data — statute transcribed
  // with citations, consumed by generic readers, never a generic branch.
  construction: CA_CONSTRUCTION,
};
