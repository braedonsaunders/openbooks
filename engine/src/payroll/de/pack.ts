import type { PayrollFilingData } from "../../payroll-filing-registry.ts";
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";
import type {
  PayrollCountryPack,
  PayrollJurisdiction,
  PayrollRegionCoverage,
} from "../packs.ts";
import type {
  PayrollPackWithholding,
  PayrollRegionWithholding,
} from "../withholding-jurisdictions.ts";
import { DE_PACK_RATES, DE_TAX_YEARS } from "./rates.ts";

/**
 * Germany payroll country pack — SKELETON (not installable).
 *
 * Declares the statutory set from primary sources (EStG, SGB III/V/VI/VII/XI,
 * Solidaritätszuschlaggesetz, Aufwendungsausgleichsgesetz) with NO transcribed
 * tables: `installable` is false, `taxYears.editions` is empty, and
 * `computeStatutory` refuses every pay date by name until the 2026 BMF
 * Programmablaufplan (BMF-Schreiben vom 12.11.2025) and the 2026 SV
 * Rechengrößen are transcribed.
 *
 * Typed as `Omit<PayrollCountryPack, "country"> & { country: "DE" }` because
 * `PayrollCountry` is still `"CA" | "US"` (packs.ts:190) — see
 * packs/proposals/payroll-country-union.md, owned by gb-payroll. The object
 * registers unchanged once Orchestrate opens the union.
 */

const DE_UNTRANSCRIBED =
  "DE payroll pack: tax year 2026 is not transcribed — the BMF "
  + "Programmablaufplan für den Lohnsteuerabzug 2026 (BMF-Schreiben vom "
  + "12.11.2025) and the 2026 SV Rechengrößen "
  + "(Sozialversicherungs-Rechengrößenverordnung 2026) have not been "
  + "transcribed into engine/src/payroll/de/.";

const DE_KIST_REFUSAL =
  "Kirchenlohnsteuer is not withheld by this pack: it is assessed per Land "
  + "from the employee's ELStAM confession key (8% in Bayern and "
  + "Baden-Württemberg, 9% elsewhere) on the Lohnsteuer base, and the base "
  + "itself is not transcribed.";

/** The 16 Bundesländer — every code an employee may legitimately carry. */
const DE_LAENDER: readonly { code: string; name: string }[] = [
  { code: "BW", name: "Baden-Württemberg" },
  { code: "BY", name: "Bayern" },
  { code: "BE", name: "Berlin" },
  { code: "BB", name: "Brandenburg" },
  { code: "HB", name: "Bremen" },
  { code: "HH", name: "Hamburg" },
  { code: "HE", name: "Hessen" },
  { code: "MV", name: "Mecklenburg-Vorpommern" },
  { code: "NI", name: "Niedersachsen" },
  { code: "NW", name: "Nordrhein-Westfalen" },
  { code: "RP", name: "Rheinland-Pfalz" },
  { code: "SL", name: "Saarland" },
  { code: "SN", name: "Sachsen" },
  { code: "ST", name: "Sachsen-Anhalt" },
  { code: "SH", name: "Schleswig-Holstein" },
  { code: "TH", name: "Thüringen" },
];

const DE_REGION_COVERAGE: PayrollRegionCoverage = {
  label: "Land",
  known: DE_LAENDER.map((land) => land.code),
  // Nothing is computed end to end: the 2026 Programmablaufplan is not
  // transcribed. Every Land is refused by name until it is.
  supported: [],
  unsupportedReason:
    "Lohnsteuer withholding for {region} is not implemented by the DE payroll "
    + "pack — the 2026 BMF Programmablaufplan (BMF-Schreiben vom 12.11.2025) "
    + "is not transcribed. " + DE_KIST_REFUSAL,
};

function deJurisdiction(code: string, name: string): PayrollJurisdiction {
  return {
    key: `DE-${code}`,
    name: `Deutschland — ${name}`,
    scope: "employment",
    // The statute family is named; the calendar itself is not transcribed.
    // Feiertagsvergütung (continued pay on holidays) is mandated federally by
    // §2 EFZG (Entgeltfortzahlungsgesetz) — `holidayPay: null` here is a
    // skeleton refusal, not a "no mandate" declaration.
    citation:
      `Feiertagsgesetz des Landes ${name} (holiday calendar not yet transcribed)`,
    holidays: [],
    holidayPay: null,
  };
}

/**
 * The employee-filed certificate: ELStAM, Elektronische
 * Lohnsteuerabzugsmerkmale (EStG §§38b, 39a, 39e). Filed with the Finanzamt,
 * retrieved by the employer — NOT a W-4/TD1 clone: Steuerklasse,
 * Kinderfreibetrag counter, confession key, and §39a allowance amounts.
 */
const DE_ELSTAM: PayrollCertificate = {
  key: "de_elstam",
  form: "ELStAM",
  label: "Elektronische Lohnsteuerabzugsmerkmale",
  scope: { level: "country" },
  purpose: "withholding",
  citation: "EStG §§38b (Steuerklassen), 39a (Freibeträge), 39e (ELStAM)",
  summary:
    "The Finanzamt-issued electronic wage-tax attributes the employer "
    + "retrieves for each employee. It sets the Steuerklasse, child-allowance "
    + "counter, confession key and §39a amounts the Programmablaufplan "
    + "computes from.",
  storage: "certificate_rows",
  fields: [
    {
      key: "steuerklasse",
      label: "Steuerklasse",
      kind: "choice",
      choices: [
        { value: "I", label: "Steuerklasse I" },
        { value: "II", label: "Steuerklasse II" },
        { value: "III", label: "Steuerklasse III" },
        { value: "IV", label: "Steuerklasse IV" },
        { value: "V", label: "Steuerklasse V" },
        { value: "VI", label: "Steuerklasse VI" },
      ],
      // Without retrievable ELStAM the employer withholds under class VI
      // (EStG §39c) — so VI, not I, is the no-answer fact.
      default: "VI",
      required: true,
      help: "Lohnsteuer class from ELStAM (EStG §38b).",
    },
    {
      key: "kinderfreibetrag_anzahl",
      label: "Zahl der Kinderfreibeträge",
      kind: "count",
      min: "0",
      default: "0",
      help: "Child-allowance counter from ELStAM (EStG §32 Abs. 6).",
    },
    {
      key: "konfession",
      label: "Kirchensteuerabzugsmerkmal (Konfession)",
      // Free key, not a closed choice: the confession keys vary by Land
      // church (rk, ev, …) and inventing the closed list would be a guess.
      kind: "code",
      help: "Confession key from ELStAM (for example rk, ev); empty when the "
        + "employee pays no Kirchenlohnsteuer, which this pack does not withhold.",
    },
    {
      key: "freibetrag",
      label: "Freibetrag (§39a EStG)",
      kind: "amount",
      decimals: 2,
      min: "0",
      help: "Annual allowance the Finanzamt granted under §39a EStG.",
    },
    {
      key: "hinzurechnungsbetrag",
      label: "Hinzurechnungsbetrag (§39a EStG)",
      kind: "amount",
      decimals: 2,
      min: "0",
      help: "Annual addition amount the Finanzamt set under §39a EStG.",
    },
  ],
};

const DE_CERTIFICATES: PayrollPackCertificates = {
  country: "DE",
  certificates: [DE_ELSTAM],
};

function deWithholdingRegion(code: string, name: string): PayrollRegionWithholding {
  return {
    region: code,
    label: `${name} Lohnsteuer`,
    implemented: false,
    unimplementedReason:
      `the 2026 BMF Programmablaufplan (BMF-Schreiben vom 12.11.2025) is not `
      + `transcribed into engine/src/payroll/de/. ${DE_KIST_REFUSAL}`,
    // Lohnsteuer is withheld by the employer on wages earned in Germany
    // whatever the employee's residence (EStG §38) — but the engine computes
    // nothing yet, so residence-side rules are honestly unknown.
    taxesNonresidentWages: true,
    residentWithholding: "unknown",
    residentWithholdingImplemented: false,
    certificateKey: "de_elstam",
    // No German municipality levies a wage income tax an employer withholds:
    // Gewerbesteuer is employer-level, never withheld from pay.
    subRegions: [],
    subRegionConflictRule: "both",
    citation:
      "EStG §§38–42f (Lohnsteuer); BMF Programmablaufplan für den "
      + "Lohnsteuerabzug 2026 (BMF-Schreiben vom 12.11.2025)",
  };
}

const DE_WITHHOLDING: PayrollPackWithholding = {
  country: "DE",
  regions: DE_LAENDER.map((land) => deWithholdingRegion(land.code, land.name)),
};

function dePackFilings() {
  return {
    country: "DE",
    programTypes: [
      {
        key: "de_finanzamt",
        label: "Betriebsstättenfinanzamt (ELSTER)",
      },
    ],
    yearEnd: [
      {
        key: "lohnsteuerbescheinigung",
        label: "Elektronische Lohnsteuerbescheinigung (§41b EStG)",
        cadence: "annual" as const,
        description:
          "The employer's annual electronic wage-tax certificate per employee, "
          + "transmitted via ELSTER (EStG §41b). Population is refused until "
          + "the 2026 tables are transcribed.",
        population: (): Promise<PayrollFilingData> =>
          Promise.reject(new Error(DE_UNTRANSCRIBED)),
        parseRowId: (): null => null,
        downloadRefusal:
          "ELSTER transmission of the Lohnsteuerbescheinigung is not "
          + "implemented by the DE payroll pack.",
        amendment: {
          supported: false as const,
          refusal:
            "Corrected Lohnsteuerbescheinigungen (berichtigte Bescheinigungen "
            + "via ELSTER) are not implemented by the DE payroll pack.",
        },
      },
    ],
  };
}

export const DE_PAYROLL_PACK: Omit<PayrollCountryPack, "country"> & {
  country: "DE";
} = {
  country: "DE",
  installable: false,
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: DE_REGION_COVERAGE,
  jurisdictions: DE_LAENDER.map((land) => deJurisdiction(land.code, land.name)),
  // Two destinations, no single vendor: Lohnsteuer/Soli go to the Finanzamt,
  // SV contributions to the Krankenkasse as Einzugsstelle (§28h SGB IV).
  // Null declares that split rather than inheriting another authority.
  remittanceVendorSettingsKey: null,
  // §39b Abs. 3 EStG: Nachzahlungen and other back pay are sonstige Bezüge,
  // taxed by the difference method — never annualized as period income.
  retroactivePayTreatment: "non_periodic",
  contributoryBases: {
    pensionable: "RV-pflichtiges Arbeitsentgelt (SGB VI)",
    insurable: "AV-pflichtiges Arbeitsentgelt (SGB III)",
  },
  // The engine computes no Lohnsteuer yet, so it gives employee-paid
  // Gewerkschaftsbeiträge no tax treatment at all.
  employeeUnionDuesTaxTreatment: null,
  filings: dePackFilings,
  statutoryRates: DE_PACK_RATES,
  taxYears: DE_TAX_YEARS,
  certificates: () => DE_CERTIFICATES,
  withholding: () => DE_WITHHOLDING,
  statutorySlots: [
    {
      key: "lohnsteuer",
      components: [
        {
          code: "LST", name: "Lohnsteuer", systemKey: "lohnsteuer",
          kind: "deduction", sequence: 110,
          assessedOn: "taxable_income", remittance: "tax_authority",
        },
      ],
    },
    {
      key: "solidaritaetszuschlag",
      components: [
        {
          code: "SOLI", name: "Solidaritätszuschlag", systemKey: "solidaritaetszuschlag",
          kind: "deduction", sequence: 115,
          assessedOn: "taxable_income", remittance: "tax_authority",
        },
      ],
    },
    {
      key: "kv",
      components: [
        {
          code: "KV", name: "Krankenversicherung", systemKey: "kv",
          kind: "deduction", sequence: 120,
          assessedOn: "earnings", remittance: "external",
        },
        {
          code: "KV-ER", name: "Krankenversicherung (Arbeitgeber)", systemKey: "kv",
          kind: "employer_contribution", sequence: 210,
          assessedOn: "earnings", remittance: "external",
        },
      ],
    },
    {
      key: "rv",
      components: [
        {
          code: "RV", name: "Rentenversicherung", systemKey: "rv",
          kind: "deduction", sequence: 130,
          assessedOn: "earnings", remittance: "external",
        },
        {
          code: "RV-ER", name: "Rentenversicherung (Arbeitgeber)", systemKey: "rv",
          kind: "employer_contribution", sequence: 215,
          assessedOn: "earnings", remittance: "external",
        },
      ],
    },
    {
      key: "av",
      components: [
        {
          code: "AV", name: "Arbeitslosenversicherung", systemKey: "av",
          kind: "deduction", sequence: 140,
          assessedOn: "earnings", remittance: "external",
        },
        {
          code: "AV-ER", name: "Arbeitslosenversicherung (Arbeitgeber)", systemKey: "av",
          kind: "employer_contribution", sequence: 220,
          assessedOn: "earnings", remittance: "external",
        },
      ],
    },
    {
      key: "pv",
      components: [
        {
          code: "PV", name: "Pflegeversicherung", systemKey: "pv",
          kind: "deduction", sequence: 150,
          assessedOn: "earnings", remittance: "external",
        },
        {
          code: "PV-ER", name: "Pflegeversicherung (Arbeitgeber)", systemKey: "pv",
          kind: "employer_contribution", sequence: 225,
          assessedOn: "earnings", remittance: "external",
        },
      ],
    },
    {
      key: "umlage",
      components: [
        {
          code: "U1", name: "Umlage U1 (Krankheit)", systemKey: "umlage_u1",
          kind: "employer_contribution", sequence: 240,
          assessedOn: "earnings", remittance: "external",
        },
        {
          code: "U2", name: "Umlage U2 (Mutterschaft)", systemKey: "umlage_u2",
          kind: "employer_contribution", sequence: 245,
          assessedOn: "earnings", remittance: "external",
        },
        {
          code: "U3", name: "Insolvenzgeldumlage", systemKey: "umlage_u3",
          kind: "employer_contribution", sequence: 250,
          assessedOn: "earnings", remittance: "external",
        },
      ],
    },
    {
      key: "unfall",
      components: [
        {
          code: "BG", name: "Berufsgenossenschaft (Unfallversicherung)", systemKey: "unfall",
          kind: "employer_contribution", sequence: 260,
          assessedOn: "earnings", remittance: "external",
        },
      ],
    },
  ],
  // Zero parameters: a skeleton refuses before reading anything, so there is
  // no context to name. (A zero-arg function satisfies the one-arg signature.)
  computeStatutory: (): Promise<Record<string, string>> =>
    Promise.reject(new Error(DE_UNTRANSCRIBED)),
  statutoryEngineLabel: "Programmablaufplan (EStG §39b)",
};
