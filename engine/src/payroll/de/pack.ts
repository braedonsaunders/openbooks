import { lohnsteuerbescheinigungFiling } from "./filings.ts";
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
import { deAnnualSettlement } from "./annual-settlement.ts";
import { computeDeStatutory, DE_FACTOR_LABELS } from "./compute-statutory.ts";
import { DE_EMPLOYEE_FACTS } from "./employee-facts.ts";
import { DE_PACK_RATES, DE_TAX_YEARS } from "./rates.ts";

/**
 * Germany payroll country pack — installable for 2026.
 *
 * The 2026 BMF Programmablaufplan für den Lohnsteuerabzug (BMF-Schreiben vom
 * 12.11.2025, Stand 12.11.2025 endgültig) is implemented in pap.ts (exact
 * integer math, 516/516 Prüftabellen cells), the 2026 SV Rechengrößen and
 * rates are transcribed in rates.ts, and computeStatutory wires the two
 * together: Lohnsteuer, Solidaritätszuschlag, Kirchenlohnsteuer (8% BY/BW,
 * 9% elsewhere, where the ELStAM Konfession is set) and the four SV branches
 * with their Beitragsbemessungsgrenzen, monthly payroll only.
 *
 * REGISTERED: `PayrollCountry` is now `keyof typeof PAYROLL_COUNTRY_PACKS`, so
 * this pack is in the registry and installable. (It was written before the
 * union opened, against a locally widened type; that scaffolding is gone.)
 */

const DE_YEAR_REFUSAL =
  "DE payroll pack: only tax year 2026 is transcribed (BMF "
  + "Programmablaufplan für den Lohnsteuerabzug 2026, BMF-Schreiben vom "
  + "12.11.2025, plus SVRV 2026).";

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
  regionNames: Object.fromEntries(DE_LAENDER.map((land) => [land.code, land.name])),
  // Lohnsteuer follows the federal PAP (no Land publishes its own tables),
  // and the engine implements the per-Land rules (KiSt 8/9 split, Sachsen PV)
  // — so every Land is supported end to end.
  supported: DE_LAENDER.map((land) => land.code),
  unsupportedReason:
    "Lohnsteuer withholding for {region} is not implemented by the DE payroll "
    + "pack. " + DE_YEAR_REFUSAL,
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
      // This help text used to end "...which this pack does not withhold",
      // which was false and actively harmful: compute-statutory.ts:241-246
      // computes Kirchenlohnsteuer at 8% in BY/BW and 9% elsewhere and pushes
      // it as a statutory line, exactly as this pack's header says. An admin
      // reading the old sentence would conclude the field did not matter and
      // leave it blank, and a blank Konfession means KIST 0.00 for an employee
      // who owes it — roughly 55 EUR a month under-withheld for a Bavarian
      // Catholic on 6,200 EUR, which is an employer liability rather than a
      // rounding difference. The prose was the defect.
      help: "Confession key from ELStAM (for example rk, ev). REQUIRED for any "
        + "employee liable to Kirchenlohnsteuer: this pack withholds it at 8% "
        + "of the Lohnsteuer in Bayern and Baden-Württemberg and 9% elsewhere. "
        + "Leave empty ONLY for an employee who owes no church tax — an empty "
        + "key withholds nothing.",
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
    {
      key: "faktor",
      label: "Faktor (§39f EStG)",
      kind: "amount",
      decimals: 3,
      min: "0.001",
      max: "1.000",
      default: "1.000",
      help: "Faktor for the Steuerklasse IV Faktorverfahren (EStG §39f), three "
        + "decimals. Only valid with Steuerklasse IV; 1.000 means no Faktorverfahren.",
    },
  ],
};

/**
 * The employer-collected PV child proof: Nachweis der Kinder für den
 * Pflegeversicherungs-Abschlag (§55 Abs. 3 SGB XI, PUEG Nachweispflicht).
 * NOT ELStAM — ELStAM carries no PV child data, and the
 * Kinderfreibetragszähler (halves per parent) cannot be mapped onto PV
 * children, so the employer enters what their records show. Without it the
 * engine refuses (compute-statutory.ts) rather than assuming childlessness.
 */
const DE_PV_NACHWEIS: PayrollCertificate = {
  key: "de_pv_nachweis",
  form: "Nachweis der Kinder (PV-Abschlag)",
  label: "Kindernachweis für die Pflegeversicherung",
  scope: { level: "country" },
  purpose: "withholding",
  citation: "§55 Abs. 3 SGB XI (Beitragszuschlag/Abschläge); §58 Abs. 1 SGB XI",
  summary:
    "The employer's record of the employee's children relevant to the "
    + "Pflegeversicherung childless surcharge and per-child discounts. "
    + "Collected from the employee (PUEG Nachweispflicht), not retrieved "
    + "from ELStAM.",
  storage: "certificate_rows",
  fields: [
    {
      key: "kinderlosenzuschlag",
      label: "Beitragszuschlag für Kinderlose",
      kind: "flag",
      default: "false",
      help: "Set when the employee is 23 or older with no eligible children "
        + "(§55 Abs. 3 Satz 1 SGB XI): the 0,6-point surcharge applies.",
    },
    {
      key: "abschlag_kinder",
      label: "Abschlag Kinder (2.–5. Kind)",
      kind: "count",
      min: "0",
      max: "4",
      default: "0",
      help: "Number of discount children (second to fifth child), 0–4: each "
        + "lowers the employee PV share by 0,25 points (§55 Abs. 3 SGB XI).",
    },
  ],
};

const DE_CERTIFICATES: PayrollPackCertificates = {
  country: "DE",
  certificates: [DE_ELSTAM, DE_PV_NACHWEIS],
};

function deWithholdingRegion(code: string, name: string): PayrollRegionWithholding {
  return {
    region: code,
    label: `${name} Lohnsteuer`,
    implemented: true,
    // Lohnsteuer is withheld by the employer on wages earned in Germany
    // whatever the employee's residence (EStG §38). Kirchenlohnsteuer rides
    // the same withholding where the ELStAM Konfession is set (8% BY/BW,
    // 9% elsewhere, on the PAP BK base).
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
    // The Ausdruck declaration lives in filings.ts beside its builders (the
    // CA/US shape): population + slip + amendment real, with the ELSTER
    // transmission named as the refused half. A refusal thrown from
    // population must extend PayrollError (PayrollPackError does) so the
    // generic enumeration converts it to this filing's own populationRefusal
    // instead of taking down the whole year-end page.
    yearEnd: [lohnsteuerbescheinigungFiling()],
  };
}

export const DE_PAYROLL_PACK: Omit<PayrollCountryPack, "country"> & {
  country: "DE";
} = {
  country: "DE",
  name: "Germany",
  // § 139b Abgabenordnung: the Bundeszentralamt für Steuern (BZSt) assigns
  // every registered person a lifelong Steuerliche Identifikationsnummer
  // (IdNr) of 11 digits. Length and digit shape only — the MOD 11,10 check
  // digit is real but unsourced here, so it is NOT enforced; ELStAM rejects
  // what is wrong. Needed for ELStAM retrieval and the Lohnsteuerbescheinigung.
  employeeIdentifier: {
    label: "Steuerliche Identifikationsnummer",
    pattern: "\\d{11}",
    formatHelp: "11 digits",
    example: "12345678901",
    requiredForPayroll: true,
    neededFor: "ELStAM",
    citation: "§ 139b AO: the BZSt assigns an 11-digit Steuerliche Identifikationsnummer (IdNr) for life",
    numericEntry: true,
  },
  installable: true,
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: DE_REGION_COVERAGE,
  jurisdictions: DE_LAENDER.map((land) => deJurisdiction(land.code, land.name)),
  // Two destinations, no single vendor: Lohnsteuer/Soli go to the Finanzamt,
  // SV contributions to the Krankenkasse as Einzugsstelle (§28h SGB IV).
  // Null declares that split rather than inheriting another authority.
  remittanceVendorSettingsKey: null,
  remittanceRegionalCalendars: {},
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
  // No pre-tax treatment transcribed: the PAP engine prices laufende Bezüge
  // off gross, so the pack declares an empty vocabulary rather than an
  // unhonored one.
  deductionTreatments: [],
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
      key: "kirchenlohnsteuer",
      components: [
        {
          code: "KIST", name: "Kirchenlohnsteuer", systemKey: "kirchenlohnsteuer",
          kind: "deduction", sequence: 117,
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
  computeStatutory: computeDeStatutory,
  statutoryEngineLabel: "Programmablaufplan (EStG §39b)",
  factorLabels: {
    ...DE_FACTOR_LABELS,
    // The settlement's own trace factors (de/annual-settlement.ts): the
    // recomputed annual tax and its three refund lines. The edition test asserts
    // every factor the settlement returns is named here.
    JAHRESLST: "Jahreslohnsteuer (§42b EStG)",
    LST_AUSGLEICH: "Lohnsteuer-Jahresausgleich — Erstattung",
    SOLI_AUSGLEICH: "Solidaritätszuschlag zum Jahresausgleich — Erstattung",
    KIST_AUSGLEICH: "Kirchenlohnsteuer zum Jahresausgleich — Erstattung",
  },
  // The monthly engine reads Steuerklasse and factors off the certificate
  // answers, never off bare profile keys; the §42b settlement additionally
  // reads the three attestation facts declared in ./employee-facts.ts
  // (required: false, so the monthly path stays untouched).
  employeeFacts: DE_EMPLOYEE_FACTS,
  // The 2026 Lohnsteuer-Jahresausgleich (§42b EStG): one edition per
  // transcribed year, null for every untranscribed year. Absent a published
  // December program for 2026, the December monthly pass stands and this
  // supplements it (adjustment_line) — see ./annual-settlement.ts.
  annualSettlement: deAnnualSettlement,
};
