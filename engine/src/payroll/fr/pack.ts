import type { PayrollCountryPack } from "../packs.ts";
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";
import type { PayrollPackWithholding } from "../withholding-jurisdictions.ts";
import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollPackFilings } from "../../payroll-filing-registry.ts";
import { computeFrStatutory } from "./compute-statutory.ts";
import { FR_TAX_YEARS } from "./rates.ts";

/**
 * France payroll pack — `installable: true` for calendar 2026.
 *
 * Calendar 2026 PAS grille I (métropole) is transcribed in ./tables-2026.ts
 * and the 2026 URSSAF cotisation rates in ./cotisations-2026.ts, both computed
 * in ./compute-statutory.ts. Declared from primary sources. APEC and
 * tenant-declared rates without an engine channel stay refused by name
 * (FR_REFUSED_2026, FR_COTISATION_REFUSALS_2026):
 * - PAS (prélèvement à la source): CGI art. 204 A et s., in force 1 Jan 2019;
 *   rate management on impots.gouv.fr ("Gérer mon prélèvement à la source").
 * - Social contributions: collected by URSSAF (C. séc. soc. art. L213-1);
 *   complementary pension by AGIRC-ARRCO (agirc-arrco.fr).
 * - DSN: monthly via net-entreprises.fr, due the 5th (50+ employees) or 15th
 *   (<50) of the month following the paid period (service-public.fr).
 */

// ---------------------------------------------------------------------------
// Regions: France levies no regional income tax — PAS is national — so the one
// known region is the country itself, and it is supported now that the grille
// computes end to end (finding F-fr-001 emptied this list at the skeleton
// stage, correctly for that state; the grille then landed).
//
// DOM domiciles are NOT a region distinction here. Grilles II and III are
// keyed by the employee's domicile, which arrives on the `fr_pas_option`
// certificate, so compute-statutory.ts refuses them by domicile name. Do not
// model them as regions: an unsupported region refuses the whole payroll,
// while the certificate answer is per employee.
// ---------------------------------------------------------------------------

const FR_REGIONS: Omit<PayrollCountryPack, "country">["regions"] = {
  label: "country",
  known: ["FR"],
  supported: ["FR"],
  unsupportedReason:
    "income tax withholding for {region} is not implemented: PAS does not compute end to end. "
    + "Transcribe the year's grille into engine/src/payroll/fr/ first.",
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
      // AGIRC-ARRCO complementary pension, tranches 1 et 2, both shares,
      // plus the CEG (general balance) and CET (technical balance, only
      // above the plafond) contributions priced by the same engine.
      // Remittance is "external": the destination is the employer's own
      // caisse de retraite, configured per component — never the URSSAF/DGFiP
      // vendor, whatever the collection channel.
      { code: "ARRCO", name: "Retraite complémentaire (salariale)", systemKey: "arrco", kind: "deduction", sequence: 140, assessedOn: "earnings", remittance: "external" },
      { code: "ARRCO-ER", name: "Retraite complémentaire (employeur)", systemKey: "arrco", kind: "employer_contribution", sequence: 240, assessedOn: "earnings", remittance: "external" },
      { code: "CEG", name: "Contribution d'équilibre général (salariale)", systemKey: "ceg", kind: "deduction", sequence: 141, assessedOn: "earnings", remittance: "external" },
      { code: "CEG-ER", name: "Contribution d'équilibre général (employeur)", systemKey: "ceg", kind: "employer_contribution", sequence: 241, assessedOn: "earnings", remittance: "external" },
      { code: "CET", name: "Contribution d'équilibre technique (salariale)", systemKey: "cet", kind: "deduction", sequence: 142, assessedOn: "earnings", remittance: "external" },
      { code: "CET-ER", name: "Contribution d'équilibre technique (employeur)", systemKey: "cet", kind: "employer_contribution", sequence: 242, assessedOn: "earnings", remittance: "external" },
    ],
  },
  {
    key: "patronales",
    components: [
      // Employer contributions collected by URSSAF (C. séc. soc. L213-1):
      // maladie, vieillesse, allocations familiales, AT/MP, assurance
      // chômage, AGS, FNAL/CSA/dialogue social et versement mobilité.
      // Rate × salary; the AT/MP and versement mobilité rates are the
      // employer-entered slots below (notified per establishment / commune).
      { code: "MAL-ER", name: "Assurance maladie (employeur)", systemKey: "maladie_er", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "VIEIL-ER", name: "Assurance vieillesse (employeur)", systemKey: "vieillesse_er", kind: "employer_contribution", sequence: 211, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "FAM-ER", name: "Allocations familiales (employeur)", systemKey: "allocfam_er", kind: "employer_contribution", sequence: 215, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "ATMP-ER", name: "Accidents du travail / maladies pro. (employeur)", systemKey: "atmp", kind: "employer_contribution", sequence: 220, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "CHOM-ER", name: "Assurance chômage (employeur)", systemKey: "chomage_er", kind: "employer_contribution", sequence: 225, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "AGS-ER", name: "Cotisation AGS (employeur)", systemKey: "ags_er", kind: "employer_contribution", sequence: 226, assessedOn: "earnings", remittance: "tax_authority" },
      { code: "CDN-ER", name: "FNAL, CSA, dialogue social et versement mobilité (employeur)", systemKey: "cdn_er", kind: "employer_contribution", sequence: 230, assessedOn: "earnings", remittance: "tax_authority" },
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
      key: "domicile",
      label: "Domicile fiscal (grille applicable)",
      kind: "choice",
      choices: [
        { value: "metropole_hors_france", label: "Métropole ou hors de France (grille I)" },
        { value: "guadeloupe_reunion_martinique", label: "Guadeloupe, Réunion, Martinique (grille II — non transcrite)" },
        { value: "guyane_mayotte", label: "Guyane, Mayotte (grille III — non transcrite)" },
      ],
      // No default, required: the three grilles differ by domicile
      // (BOI-IR-PAS-20-20-30-10 §90) and an undeclared domicile must not
      // fall through to grille I. The engine refuses anything but
      // metropole_hors_france by name.
      required: true,
      help: "Résidence principale à la date du versement. Seule la grille I (métropole ou hors de France) est transcrite ; les grilles II et III sont refusées par l'employeur.",
    },
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
      // Implemented for grille I (métropole ou hors de France): PAS plus
      // the 2026 URSSAF cotisations and AGIRC-ARRCO T1/T2 + CEG + CET
      // compute end to end. DOM domiciles, APEC and tenant-declared
      // AT/MP/versement-mobilité rates stay refused by name (see
      // FR_REFUSED_2026 and FR_COTISATION_REFUSALS_2026).
      implemented: true,
      // Non-residents face the specific retenue à la source (CGI art. 182 A),
      // not PAS — a separate mechanism the skeleton does not implement either.
      taxesNonresidentWages: true,
      residentWithholding: "required",
      residentWithholdingImplemented: true,
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
    {
      key: "fr_versement_mobilite",
      label: "Taux versement mobilité",
      // Per commune/authority zone: the rate depends on where the
      // establishment sits, so it rides the same SIRET filing account as
      // the AT/MP rate — never a published table.
      scope: "filing_account",
      programType: "fr_siret",
      systemKeys: ["cdn_er"],
      regions: ["FR"],
      citation: "urssaf.fr, taux et barèmes — Versement mobilité (effectif de 11 salariés et plus)",
      variesBecause:
        "The rate is set per autorité organisatrice de la mobilité from the establishment's commune — a figure no published table can supply.",
      fields: [
        {
          key: "taux", label: "Taux versement mobilité (%)", kind: "percent", decimals: 4,
          min: "0", max: "100", required: true,
          help: "As a percent, as the URSSAF versement-mobilité lookup returns it for this establishment's commune.",
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
  // installable flips to true once packAccounts.FR.slots.* statutory-account
  // labels land in web/messages (labels shard owns all seven locales) — the
  // messages-catalog gate fires on those four keys until then, so the flip
  // waits for labels rather than shipping red. The 2026 payslip itself
  // (PAS + URSSAF + AGIRC-ARRCO) is proven by the parity harnesses below.
  installable: true,
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
  computeStatutory: computeFrStatutory,
  statutoryEngineLabel: "PAS",
} satisfies Omit<PayrollCountryPack, "country"> & { country: "FR" };
