/**
 * The CA pack's declarations: the certificates its employees file, and the
 * provinces that withhold.
 *
 * Authored HERE, in the pack, beside the engine that reads them — the same
 * arrangement `engine/src/payroll/us/jurisdictions.ts` uses, and for the same
 * reason. Nothing in the generic layer (`certificates.ts`,
 * `withholding-jurisdictions.ts`, `withholding-resolution.ts`) names a country,
 * a province or a form, so Canada answers the same interface the United States
 * does or the interface is a US interface with a country column.
 *
 * Two things this declaration buys immediately:
 *
 *   1. the TD1 family becomes a CERTIFICATE rather than a scatter of columns —
 *      declared, not migrated (`storage: "profile_columns"`, every field naming
 *      the `employee_payroll_profiles` column that already holds the answer), so
 *      the engine, the API and the editor ask one question of both storages;
 *   2. a Québec resident working in Ontario is REFUSED BY NAME instead of being
 *      silently withheld Ontario only. Nobody has established whether a province
 *      requires an employer to withhold from a resident's out-of-province wages,
 *      so `residentWithholding` is `unknown` — the value that exists precisely
 *      so 13 unresearched jurisdictions are not defaulted to a guess.
 */
import {
  type PayrollCertificate,
  type PayrollCertificateField,
  type PayrollPackCertificates,
} from "../certificates.ts";
import type {
  PayrollPackWithholding,
  PayrollRegionWithholding,
} from "../withholding-jurisdictions.ts";
import type { Province } from "./rates.ts";

/** Every T4127 province code, plus ZZ (employment outside any province). */
const CA_PROVINCES: readonly Province[] = [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT", "ZZ",
];

const PROVINCE_NAMES: Readonly<Record<string, string>> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories",
  NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Québec",
  SK: "Saskatchewan", YT: "Yukon",
  ZZ: "employment outside Canada",
};

// ===========================================================================
// Certificates
// ===========================================================================

/**
 * The fields every TD1 shares with the federal one, at whichever level.
 *
 * Declared once and reused rather than typed out fourteen times: the TD1 and
 * every TD1XX are the same form with a different legislature's amounts on it,
 * which is exactly why the answers live in one pair of columns.
 */
const ADDITIONAL_TAX: PayrollCertificateField = {
  key: "additional_tax_per_period",
  label: "Additional tax to be deducted (per pay period)",
  kind: "amount", decimals: 4, min: "0",
  storage: { kind: "column", column: "additional_tax_per_period" },
  help: "The TD1's \"Additional tax to be deducted\" — an amount the employee asks to have "
    + "withheld from EVERY pay in addition to the calculated tax (T4127 factor L). It is a "
    + "per-period amount, not an annual one.",
};

/**
 * Form TD1 — the federal personal tax credits return.
 *
 * `storage: "profile_columns"`: nothing is migrated. Every field names the
 * column that already holds its answer, and `resolveCertificate` reads through
 * the mapping, so the T4127 conformance goldens compute from exactly the same
 * numbers they always have. See the header of engine/src/payroll/certificates.ts
 * for why the move is deferred to a pass whose only job is the move.
 */
const TD1: PayrollCertificate = {
  key: "ca_td1",
  form: "TD1",
  label: "Personal Tax Credits Return (federal)",
  scope: { level: "country" },
  purpose: "withholding",
  citation: "CRA Form TD1 (2026); T4127 Payroll Deductions Formulas, 123rd edition",
  summary:
    "Filed on hire and whenever the employee's credits change. It sets the federal claim amount "
    + "(factor TC), the deductions authorized by a tax services office, and any extra tax the "
    + "employee wants withheld each pay.",
  storage: "profile_columns",
  fields: [
    {
      key: "federal_claim_code", label: "Total claim amount — claim code", kind: "count",
      min: "0", max: "10", storage: { kind: "column", column: "federal_claim_code" },
      help: "The CRA's claim code 0–10, from the TD1 total. Code 1 is the basic personal amount "
        + "alone and is what an employee who files nothing is withheld at; code 0 claims no "
        + "credits at all, which is not the same thing.",
    },
    {
      key: "federal_claim_amount", label: "Total claim amount — exact dollars",
      kind: "amount", decimals: 4, min: "0",
      storage: { kind: "column", column: "federal_claim_amount" },
      help: "The exact TD1 total, which OVERRIDES the claim code when both are present. The code "
        + "is a band; the amount is what the employee actually claimed, and T4127 factor TC uses "
        + "it directly.",
    },
    {
      key: "prescribed_zone_deduction", label: "Prescribed zone deduction (annual)",
      kind: "amount", decimals: 4, min: "0",
      storage: { kind: "column", column: "prescribed_zone_deduction" },
      help: "The annual living-in-a-prescribed-zone deduction from the TD1 (T4127 factor HD). "
        + "Northern residents only.",
    },
    {
      key: "authorized_annual_deductions", label: "Deductions authorized by a tax services office",
      kind: "amount", decimals: 4, min: "0",
      storage: { kind: "column", column: "authorized_annual_deductions" },
      help: "Annual deductions a tax services office has authorized in a letter to the employee "
        + "(T4127 factor F2) — alimony, child support, employment expenses. Only with the letter.",
    },
    {
      key: "authorized_federal_credits", label: "Federal tax credits authorized in a letter",
      kind: "amount", decimals: 4, min: "0",
      storage: { kind: "column", column: "authorized_federal_credits" },
      help: "Federal non-refundable credits a tax services office has authorized (T4127 factor "
        + "K3) — most often foreign tax credits.",
    },
    ADDITIONAL_TAX,
    {
      key: "tax_exempt", label: "No income tax is to be withheld", kind: "flag",
      storage: { kind: "column", column: "tax_exempt" },
      help: "Claim code E, a CRA letter of authority, or Indian Act section 87 exempt employment. "
        + "Income tax only: CPP and EI still apply unless they are separately exempt.",
    },
    {
      key: "cpp_exempt", label: "Exempt from CPP/QPP contributions", kind: "flag",
      storage: { kind: "column", column: "cpp_exempt" },
      help: "Under 18, over 70, in receipt of a CPP/QPP retirement pension with a CPT30 election "
        + "on file, or employment the Canada Pension Plan does not cover.",
    },
    {
      key: "ei_exempt", label: "Exempt from EI premiums", kind: "flag",
      storage: { kind: "column", column: "ei_exempt" },
      help: "Non-arm's-length employment the Canada Employment Insurance Commission has ruled "
        + "uninsurable, or a controlling shareholder.",
    },
  ],
};

/**
 * The PROVINCIAL certificate, one per province, generated from the same three
 * columns.
 *
 * Every province publishes its own form — TD1ON, TD1BC, TD1AB — and Québec
 * publishes TP-1015.3-V instead, which is a genuinely different form filed with
 * a different authority. They are declared as fourteen certificates rather than
 * one because that is fourteen forms an employee can be holding, and a product
 * that calls the Québec form "TD1" cannot help somebody fill it in. They are
 * GENERATED rather than typed out because the three answers the pack reads are
 * the same three on all of them, and typing them fourteen times is fourteen
 * chances to disagree.
 */
function provincialCertificate(province: string): PayrollCertificate {
  const quebec = province === "QC";
  const name = PROVINCE_NAMES[province] ?? province;
  return {
    key: `ca_td1_${province}`,
    form: quebec ? "TP-1015.3-V" : `TD1${province}`,
    label: quebec
      ? "Source Deductions Return (Québec)"
      : `Personal Tax Credits Return (${name})`,
    scope: { level: "region", region: province },
    purpose: "withholding",
    citation: quebec
      ? "Revenu Québec Form TP-1015.3-V (2026); TP-1015.F-V Formulas to Calculate Source Deductions"
      : `CRA Form TD1${province} (2026); T4127 Payroll Deductions Formulas, 123rd edition`,
    summary: quebec
      ? "Québec's own source deductions return, filed with the employer in addition to the "
        + "federal TD1. It sets the deduction code and amount the TP-1015 provincial calculation "
        + "uses; a Québec employee files BOTH forms."
      : `Sets the ${name} claim amount the provincial half of the T4127 calculation uses `
        + "(factor TCP). An employee who files nothing is withheld at the basic personal amount.",
    storage: "profile_columns",
    fields: [
      {
        key: "provincial_claim_code",
        label: quebec ? "Deduction code" : "Total claim amount — claim code",
        kind: "count", min: "0", max: "10",
        storage: { kind: "column", column: "provincial_claim_code" },
        help: quebec
          ? "Revenu Québec's deduction code from the TP-1015.3-V, in the same 0–10 shape the CRA "
            + "uses. Code 1 is the basic amount alone."
          : "The provincial claim code 0–10. It is NOT necessarily the same code as the federal "
            + "one: the provinces set their own basic personal amounts and credits.",
      },
      {
        key: "provincial_claim_amount",
        label: quebec ? "Deduction amount — exact dollars" : "Total claim amount — exact dollars",
        kind: "amount", decimals: 4, min: "0",
        storage: { kind: "column", column: "provincial_claim_amount" },
        help: "The exact total from the form, which OVERRIDES the code when both are present "
          + "(T4127 factor TCP, TP-1015 variable E).",
      },
      {
        key: "authorized_provincial_credits",
        label: "Provincial tax credits authorized in a letter",
        kind: "amount", decimals: 4, min: "0",
        storage: { kind: "column", column: "authorized_provincial_credits" },
        help: "Provincial or territorial non-refundable credits an authority has authorized in "
          + "writing (T4127 factor K3P). Only with the letter.",
      },
    ],
  };
}

const CA_CERTIFICATES: PayrollPackCertificates = {
  country: "CA",
  certificates: [TD1, ...CA_PROVINCES.filter((p) => p !== "ZZ").map(provincialCertificate)],
};

// ===========================================================================
// Withholding jurisdictions
// ===========================================================================

/**
 * A province, as the withholding resolution sees it.
 *
 * `implemented: true` for all of them — T4127 computes the provincial tax for
 * every province and engine/src/payroll/canada/quebec computes TP-1015 for
 * Québec, which is exactly what `PayrollRegionCoverage.supported` already says.
 *
 * `residentWithholding: "unknown"` for all of them, and that is not laziness:
 * NOBODY HAS ESTABLISHED THE RULE. The CRA's own instruction is that source
 * deductions follow the province of the establishment the employee REPORTS TO,
 * which answers the withholding question for the common case and says nothing
 * about whether a second province may also claim — and a Québec resident
 * reporting to an Ontario establishment is a real, common employee whose
 * Québec liability is settled on the annual return rather than by the employer.
 * Declaring `not_required` would be the likely answer and would be a guess; the
 * resolver refuses that employee by name until somebody reads the statute,
 * which is the whole reason the value exists.
 */
function caRegion(province: string): PayrollRegionWithholding {
  const name = PROVINCE_NAMES[province] ?? province;
  const quebec = province === "QC";
  return {
    region: province,
    label: quebec ? "Québec income tax" : `${name} income tax`,
    implemented: true,
    // A person working in the province pays the province's tax whoever they
    // are: Canadian source deductions follow the establishment the employee
    // reports to, not their home address.
    taxesNonresidentWages: true,
    residentWithholding: "unknown",
    residentWithholdingImplemented: false,
    ...(province === "ZZ" ? {} : { certificateKey: `ca_td1_${province}` }),
    // No Canadian municipality levies an income tax on wages. Not an omission:
    // municipal taxation is provincially delegated and no province has
    // delegated an income or payroll tax an employer withholds from an
    // employee's pay.
    subRegions: [],
    subRegionConflictRule: "both",
    citation: quebec
      ? "Revenu Québec TP-1015.F-V, Formulas to Calculate Source Deductions and Contributions; "
        + "Taxation Act (Québec)"
      : "CRA T4127, Payroll Deductions Formulas (123rd edition); Income Tax Act s. 153(1) and "
        + "Income Tax Regulations part I",
  };
}

const CA_WITHHOLDING_JURISDICTIONS: PayrollPackWithholding = {
  country: "CA",
  regions: CA_PROVINCES.map(caRegion),
};

/**
 * No reciprocity declaration at all, which is the honest answer rather than an
 * empty one: Canada's provinces have no interprovincial withholding agreements
 * of the US kind. Relief for a person taxed by two provinces is settled on the
 * annual return, so there is no form an employee files with an employer and
 * nothing for the resolver to consult. `packReciprocity` treats an absent
 * declaration and an empty list identically, and the CA pack therefore declares
 * no `reciprocity` member at all.
 */

export { CA_CERTIFICATES, CA_WITHHOLDING_JURISDICTIONS };
