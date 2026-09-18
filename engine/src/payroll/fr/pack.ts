import { PayrollPackError, type PayrollCountryPack } from "../packs.ts";
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";
import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollPackFilings } from "../../payroll-filing-registry.ts";
import { FR_TAX_YEARS } from "./rates.ts";

/**
 * France payroll pack (skeleton).
 *
 * Registers nothing: `PayrollCountry` is still `"CA" | "US"` (packs.ts:190),
 * so this object cannot be added to `PAYROLL_COUNTRY_PACKS` yet — see
 * `packs/proposals/payroll-country-union.md`, cited in the shard ledger.
 * It is written against the pack contract (`Omit<PayrollCountryPack,
 * "country">`, asserted below) so it registers unchanged once Orchestrate
 * opens the union. `installable: false` until a tax year is transcribed.
 *
 * Declared from primary sources; no 2026 barème is transcribed here:
 * - PAS (prélèvement à la source): CGI art. 204 A et s., in force 1 Jan 2019;
 *   rate management on impots.gouv.fr ("Gérer mon prélèvement à la source").
 * - Social contributions: collected by URSSAF (C. séc. soc. art. L213-1);
 *   complementary pension by AGIRC-ARRCO (agirc-arrco.fr).
 * - DSN: monthly via net-entreprises.fr, due the 5th (50+ employees) or 15th
 *   (<50) of the month following the paid period (service-public.fr).
 */

// ---------------------------------------------------------------------------
// Regions: France levies no regional income tax — PAS is national.
// ---------------------------------------------------------------------------

const FR_REGIONS: Omit<PayrollCountryPack, "country">["regions"] = {
  label: "country",
  known: ["FR"],
  supported: ["FR"],
  unsupportedReason:
    "France levies no regional income tax: PAS is computed nationally, so {region} has no separate withholding to implement",
};

// ---------------------------------------------------------------------------
// Statutory slots. Named buckets only — no rates live here.
// ---------------------------------------------------------------------------

const FR_SLOTS: Omit<PayrollCountryPack, "country">["statutorySlots"] = [
  {
    key: "pas",
    components: [
      // CGI art. 204 A: PAS is rate × monthly net imposable, so a pre-tax
      // deduction moves it — re-derived by the fixpoint like T4127 factor T.
      { code: "PAS", name: "Prélèvement à la source", systemKey: "pas", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
    ],
  },
  {
    key: "salariales",
    components: [
      // Employee social contributions collected by URSSAF: assurance
      // vieillesse (plafonnée et déplafonnée), CSG, CRDS. Rate × salary —
      // deductions do not enter.
      { code: "VIEIL", name: "Assurance vieillesse (salariale)", systemKey: "vieillesse", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "CSG", name: "CSG (salariale)", systemKey: "csg", kind: "deduction", sequence: 130, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "CRDS", name: "CRDS (salariale)", systemKey: "crds", kind: "deduction", sequence: 135, assessedOn: "earnings", remittance: "tax_authority" },
    ],
  },
  {
    key: "retraite_comp",
    components: [
      // AGIRC-ARRCO complementary pension, tranches 1 et 2, both shares.
      // Remittance is "external": the destination is the employer's own
      // caisse de retraite, configured per component — never the URSSAF/DGFiP
      // vendor, whatever the collection channel.
      { code: "ARRCO", name: "Retraite complémentaire (salariale)", systemKey: "arrco", kind: "deduction", sequence: 140, assessedOn: "earnings", remittance: "external" },
      { code: "ARRCO-ER", name: "Retraite complémentaire (employeur)", systemKey: "arrco", kind: "employer_contribution", sequence: 240, assessedOn: "earnings", remittance: "external" },
    ],
  },
  {
    key: "patronales",
    components: [
      // Employer contributions collected by URSSAF (C. séc. soc. L213-1):
      // maladie, allocations familiales, AT/MP, assurance chômage, FNAL/CSA
      // et versement mobilité. Rate × salary; the AT/MP rate is the
      // employer-entered `fr_atmp` slot below (notified per establishment).
      { code: "MAL-ER", name: "Assurance maladie (employeur)", systemKey: "maladie_er", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "FAM-ER", name: "Allocations familiales (employeur)", systemKey: "allocfam_er", kind: "employer_contribution", sequence: 215, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "ATMP-ER", name: "Accidents du travail / maladies pro. (employeur)", systemKey: "atmp", kind: "employer_contribution", sequence: 220, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "CHOM-ER", name: "Assurance chômage (employeur)", systemKey: "chomage_er", kind: "employer_contribution", sequence: 225, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "CDN-ER", name: "FNAL, CSA et versement mobilité (employeur)", systemKey: "cdn_er", kind: "employer_contribution", sequence: 230, assessedOn: "earnings", remittance: "tax_authority" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Certificates: the PAS rate option — a DGFiP fact, not a W-4 clone.
// ---------------------------------------------------------------------------

const FR_PAS_CERTIFICATE: PayrollCertificate = {
  key: "fr_pas_option",
  form: "2043",
  label: "Demande de numéro fiscal et de taux personnalisé de prélèvement à la source",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "impots.gouv.fr — Gérer mon prélèvement à la source; formulaire n° 2043 "
    + "(demande de numéro fiscal et de taux personnalisé)",
  summary:
    "The PAS rate option the employee chose with DGFiP; DGFiP transmits the resulting rate to the employer.",
  storage: "certificate_rows",
  fields: [
    {
      key: "taux_option",
      label: "Option de taux",
      kind: "choice",
      choices: [
        { value: "personnalise", label: "Taux personnalisé (foyer)" },
        { value: "individualise", label: "Taux individualisé (au sein du foyer)" },
        { value: "non_personnalise", label: "Grille par défaut (taux non personnalisé)" },
      ],
      // With no transmitted rate the employer applies the statutory default
      // grid to the month's net imposable — that is the "non personnalisé" arm.
      default: "non_personnalise",
      help: "Which PAS rate the employee elected with DGFiP. DGFiP sends the resulting rate to the employer; until one arrives the default grid applies.",
    },
    {
      key: "taux_transmis",
      label: "Taux transmis par la DGFiP (%)",
      kind: "amount",
      decimals: 1,
      min: "0",
      max: "100",
      help: "The PAS rate DGFiP returned for this employee, as a percent (7.5 means 7.5%). Copied from the DGFiP retour, never computed here.",
    },
  ],
};

const FR_CERTIFICATES: PayrollPackCertificates = {
  country: "FR",
  certificates: [FR_PAS_CERTIFICATE],
};

// ---------------------------------------------------------------------------
// Withholding: one national region, unimplemented until tables land.
// ---------------------------------------------------------------------------

const FR_WITHHOLDING: PayrollPackWithholding = {
  country: "FR",
  regions: [
    {
      region: "FR",
      label: "Prélèvement à la source (national)",
      implemented: false,
      unimplementedReason:
        "the FR payroll pack has transcribed no PAS barème — 2026 refused by name on taxYears. "
        + "Transcribe the year's grille into engine/src/payroll/fr/ first.",
      // Non-residents face the specific retenue à la source (CGI art. 182 A),
      // not PAS — a separate mechanism the skeleton does not implement either.
      taxesNonresidentWages: true,
      residentWithholding: "required",
      residentWithholdingImplemented: false,
      certificateKey: "fr_pas_option",
      subRegions: [],
      // Vacuous: France declares no sub-region wage levies, so no comparison
      // ever runs. Revisit if one is ever declared.
      subRegionConflictRule: "work_only",
      citation:
        "CGI art. 204 A et s. (prélèvement à la source, en vigueur depuis le "
        + "1er janvier 2019); CGI art. 182 A (retenue à la source des non-résidents)",
    },
  ],
};

// ---------------------------------------------------------------------------
// Employer-entered rates: the AT/MP rate, notified per establishment.
// ---------------------------------------------------------------------------

const FR_RATES: PayrollPackRates = {
  country: "FR",
  slots: [
    {
      key: "fr_atmp",
      label: "Taux AT/MP",
      // Per establishment: the rate rides the SIRET filing account, the same
      // account the DSN is filed under — not one org-wide number.
      scope: "filing_account",
      programType: "fr_siret",
      systemKeys: ["atmp"],
      regions: ["FR"],
      citation: "Code de la sécurité sociale, art. L242-5 (taux notifié par la caisse)",
      variesBecause:
        "The caisse notifies each establishment its own AT/MP rate from its activity risk class and sinistrality — a figure no published table can supply.",
      fields: [
        {
          key: "taux", label: "Taux AT/MP (%)", kind: "percent", decimals: 4,
          min: "0", max: "100", required: true,
          help: "As a percent, as the caisse notifies it: 1.1 is 1.1%. Enter the rate notified for this establishment.",
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Filings: the SIRET filing account. DSN itself is monthly — the cadence
// channel offers annual | quarterly | separation only, so no monthly filing
// is declared here (ledger note; a channel question for Orchestrate, not a
// second engine).
// ---------------------------------------------------------------------------

const FR_FILINGS: PayrollPackFilings = {
  country: "FR",
  programTypes: [
    { key: "fr_siret", label: "SIRET — établissement employeur (DSN)" },
  ],
  yearEnd: [],
};

// ---------------------------------------------------------------------------
// Employment calendars: the 11 jours fériés légaux (C. trav. L3133-1), plus
// the two droit-local days in Alsace-Moselle (Vendredi saint, 26 décembre).
// Holiday pay is undeclared (null): no computation is transcribed.
// ---------------------------------------------------------------------------

const FR_NATIONAL_HOLIDAYS: PayrollCountryPack["jurisdictions"][number]["holidays"] = [
  { key: "fr_new_year", name: "Jour de l'An", rule: { kind: "fixed", month: 1, day: 1 }, observance: "none" },
  { key: "fr_easter_monday", name: "Lundi de Pâques", rule: { kind: "easter_offset", days: 1 }, observance: "none" },
  { key: "fr_labour_day", name: "Fête du Travail (1er mai)", rule: { kind: "fixed", month: 5, day: 1 }, observance: "none" },
  { key: "fr_victory_day", name: "Victoire 1945 (8 mai)", rule: { kind: "fixed", month: 5, day: 8 }, observance: "none" },
  { key: "fr_ascension", name: "Ascension", rule: { kind: "easter_offset", days: 39 }, observance: "none" },
  { key: "fr_whit_monday", name: "Lundi de Pentecôte", rule: { kind: "easter_offset", days: 50 }, observance: "none" },
  { key: "fr_bastille_day", name: "Fête nationale (14 juillet)", rule: { kind: "fixed", month: 7, day: 14 }, observance: "none" },
  { key: "fr_assumption", name: "Assomption", rule: { kind: "fixed", month: 8, day: 15 }, observance: "none" },
  { key: "fr_all_saints", name: "Toussaint", rule: { kind: "fixed", month: 11, day: 1 }, observance: "none" },
  { key: "fr_armistice", name: "Armistice 1918 (11 novembre)", rule: { kind: "fixed", month: 11, day: 11 }, observance: "none" },
  { key: "fr_christmas", name: "Noël", rule: { kind: "fixed", month: 12, day: 25 }, observance: "none" },
];

const FR_JURISDICTIONS: PayrollCountryPack["jurisdictions"] = [
  {
    key: "FR",
    name: "France",
    scope: "employment",
    citation: "Code du travail, art. L3133-1 (jours fériés légaux)",
    holidays: FR_NATIONAL_HOLIDAYS,
    holidayPay: null,
  },
  {
    key: "FR-AM",
    name: "France — Alsace-Moselle (droit local)",
    scope: "employment",
    citation:
      "Droit local d'Alsace-Moselle: Vendredi saint et 26 décembre (Saint-Étienne) "
      + "chômés en Moselle, Bas-Rhin et Haut-Rhin (service-public.fr F2405)",
    holidays: [
      ...FR_NATIONAL_HOLIDAYS,
      { key: "fr_good_friday", name: "Vendredi saint", rule: { kind: "easter_offset", days: -2 }, observance: "none" },
      { key: "fr_st_stephen", name: "Saint-Étienne (26 décembre)", rule: { kind: "fixed", month: 12, day: 26 }, observance: "none" },
    ],
    holidayPay: null,
  },
];

// ---------------------------------------------------------------------------
// The pack.
// ---------------------------------------------------------------------------

export const FR_PAYROLL_PACK = {
  country: "FR",
  installable: false,
  statutorySlots: FR_SLOTS,
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: FR_REGIONS,
  jurisdictions: FR_JURISDICTIONS,
  // Two authorities share the money — DGFiP takes PAS (via DSN/PASRAU), URSSAF
  // takes the social contributions — so no single statutory vendor is named.
  // `tax_authority` withholdings surface unassigned until configured, as with
  // the US pack's EFTPS arrangement.
  remittanceVendorSettingsKey: null,
  // PAS applies the employee's personal rate to each month's net imposable:
  // exceptional payments (primes, rappels) join the month's base with no
  // annualization and no bonus method — taxed as ordinary income of the period
  // paid (impots.gouv.fr, prélèvement à la source).
  retroactivePayTreatment: "periodic",
  contributoryBases: {
    pensionable: "Salaire soumis aux cotisations vieillesse (plafonnée et déplafonnée) et à la retraite complémentaire AGIRC-ARRCO (tranches 1 et 2)",
    // No employee contribution in this pack is assessed on a separate
    // insurable base: employer assurance chômage is assessed on total salary,
    // so the flag accumulates nothing here rather than inheriting another
    // jurisdiction's EI/FUTA meaning.
    insurable: "unused — no employee-paid contribution is assessed on a separate insurable base",
  },
  // Union dues open a crédit d'impôt on the annual return, not a deduction at
  // source — the statutory engine gives dues no treatment.
  employeeUnionDuesTaxTreatment: null,
  filings: () => FR_FILINGS,
  statutoryRates: FR_RATES,
  taxYears: FR_TAX_YEARS,
  certificates: () => FR_CERTIFICATES,
  withholding: () => FR_WITHHOLDING,
  computeStatutory: async (): Promise<Record<string, string>> => {
    throw new PayrollPackError(
      "the FR payroll pack is not installable: no PAS barème or URSSAF parameters are transcribed "
      + "(2026 refused by name on taxYears). Transcribe the year's tables into engine/src/payroll/fr/ first.",
    );
  },
  statutoryEngineLabel: "PAS",
} satisfies Omit<PayrollCountryPack, "country"> & { country: "FR" };
