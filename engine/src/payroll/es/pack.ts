/**
 * The España payroll pack (`installable: true` — 2026 computes end to end
 * and the adapter golden pushes all ten lines through the
 * declaration-enforcing push path; ES slot labels landed in all seven
 * locales).
 *
 * Declares IRPF withholding (AEAT) and Seguridad Social employee + employer
 * contributions (TGSS) as statutory slots, the Modelo 145 certificate, the
 * 19-community region coverage with foral refusals, and the national holiday
 * calendar. Calendar 2026 is transcribed — the AEAT retention algorithm (both
 * September editions) and the TGSS Orden de cotización live in ./rates.ts and
 * computeStatutory prices a monthly AEAT-territory payslip through them.
 *
 * REGISTERED: `PayrollCountry` is now `keyof typeof PAYROLL_COUNTRY_PACKS`, so
 * this pack is in the registry, wired to a settings key, and installable.
 * (Written while the union was closed, against a locally widened type that
 * only proved structural conformance; the claim that nothing here is
 * registered no longer holds.)
 */
import type {
  PayrollCountryPack,
  PayrollRegionCoverage,
} from "../packs.ts";
import { ES_CERTIFICATES } from "./certificates.ts";
import { computeEsStatutory, ES_FACTOR_LABELS } from "./compute-statutory.ts";
import { esPackFilings } from "./filings.ts";
import { ES_COMUNIDADES, ES_JURISDICTIONS } from "./jurisdictions.ts";
import { ES_PACK_RATES, ES_TAX_YEARS } from "./rates.ts";
import { ES_WITHHOLDING } from "./withholding.ts";
import { ES_EMPLOYEE_FACTS } from "./employee-facts.ts";

/** Structural conformance without the closed union (see module doc). */
export type EsPayrollPack = Omit<PayrollCountryPack, "country"> & {
  country: "ES";
};

/** AEAT-territory communities: every known code except the foral NC/PV. */
const ES_AEAT_SUPPORTED = [
  "AN", "AR", "AS", "CN", "CB", "CL", "CM", "CT", "EX", "GA",
  "IB", "RI", "MD", "MC", "VC", "CE", "ML",
];

/**
 * Display name per autonomous community and city code, for pickers and
 * labels. Derived from ES_COMUNIDADES — the pack's region names live in
 * ./jurisdictions.ts beside the holiday calendar that reads them, so no
 * generic layer maps codes to names and the two can never drift apart.
 */
const ES_REGION_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  ES_COMUNIDADES.map((comunidad) => [comunidad.code, comunidad.name]),
);

const ES_REGIONS: PayrollRegionCoverage = {
  label: "autonomous community",
  known: ES_COMUNIDADES.map((comunidad) => comunidad.code),
  regionNames: ES_REGION_NAMES,
  // The 2026 AEAT algorithm is transcribed (see ./rates.ts) and the engine
  // computes AEAT-territory IRPF end to end — only the foral NC/PV stay out.
  supported: ES_AEAT_SUPPORTED,
  unsupportedReason:
    "IRPF withholding for {region} is not implemented by the ES payroll pack — the pack computes "
    + "AEAT-territory IRPF from the year's transcribed ALGORITMO and refuses the foral NC/PV by name, "
    + "so reaching this message means {region} has no declared rule — refusing, never defaulting",
  unsupportedReasons: {
    NC: "Navarra applies the foral IRPF regime: foral retention tables for Navarra "
      + "(Hacienda Foral de Navarra) aren't in this pack — AEAT tables never cover Navarra. "
      + "Transcribe them into engine/src/payroll/es/rates.ts before calculating",
    PV: "the Basque Historical Territories — Álava/Araba, Gipuzkoa and Bizkaia — apply the "
      + "foral IRPF regime: foral retention tables for the three Haciendas Forales aren't in this pack — "
      + "AEAT tables never cover them. Transcribe them into engine/src/payroll/es/rates.ts before calculating",
  },
};

export const ES_PAYROLL_PACK: EsPayrollPack = {
  country: "ES",
  name: "Spain",
  // Dirección General de la Policía (DGP): "número de DNI con letra | NIE
  // con letra" — a DNI is 8 digits plus a verification letter and a NIE is
  // X/Y/Z plus 7 digits plus a letter (EU TIN-ES factsheet likewise). The
  // mod-23 control letter is NOT enforced (unsourced here). Needed for the
  // Modelo 190 annual withholding summary.
  employeeIdentifier: {
    label: "DNI/NIE",
    pattern: "(?:\\d{8}[A-Z]|[XYZ]\\d{7}[A-Z])",
    formatHelp: "DNI: 8 digits + letter; NIE: X/Y/Z + 7 digits + letter",
    example: "12345678Z",
    requiredForPayroll: true,
    neededFor: "Modelo 190",
    citation: "DGP: 'número de DNI con letra | NIE con letra' (EU TIN-ES: DNI 8 digits + letter; NIE X/Y/Z + 7 digits + letter)",
    numericEntry: false,
  },
  installable: true,
  // The AEAT pack computes in euro; IRPF and TGSS settle in euro.
  statutoryCurrency: "EUR",
  // LIRPF art. 12: el período impositivo es el año natural.
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: ES_REGIONS,
  jurisdictions: ES_JURISDICTIONS,
  // IRPF retentions settle with the AEAT, but payroll settings only store
  // cra/rq today. A key naming a field that does not exist looks wired.
  // Null until Orchestrate adds an AEAT remittance-party settings field.
  remittanceVendorSettingsKey: null,
  remittanceRegionalCalendars: {},
  // Atrasos (arrears) are imputed to the year they became due (LIRPF art. 14)
  // and regularised on declaración complementaria — a re-spread the two-value
  // channel cannot express (proposed to Orchestrate). At WITHHOLDING time the
  // payer withholds on payment under current tables, which is the periodic
  // path; the declaration is inert while computeStatutory refuses.
  retroactivePayTreatment: "periodic",
  contributoryBases: {
    pensionable: "base de cotización por contingencias comunes (TGSS)",
    insurable: "base de cotización por contingencias profesionales y desempleo (TGSS)",
  },
  // Cuotas sindicales ARE deductible under LIRPF art. 19 — but stamping the
  // CRA's factor-U1 key on them would wire foreign semantics, so null until
  // the ES engine transcribes the deduction. Claims nothing.
  employeeUnionDuesTaxTreatment: null,
  // No pre-tax treatment transcribed: the engine prices IRPF off gross, so
  // the pack declares an empty vocabulary rather than an unhonored one.
  deductionTreatments: [],
  filings: esPackFilings,
  statutoryRates: ES_PACK_RATES,
  taxYears: ES_TAX_YEARS,
  certificates: () => ES_CERTIFICATES,
  withholding: () => ES_WITHHOLDING,
  statutorySlots: [
    {
      key: "irpf",
      components: [
        // The AEAT algorithm works from the period's retribuciones íntegras
        // LESS pre-tax minoraciones — a protected pre-tax deduction moves it,
        // so taxable_income, re-derived every fixpoint pass like T4127-T/FIT.
        { code: "IRPF", name: "IRPF withholding", systemKey: "irpf", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "seguridad_social",
      // ONE slot for every SS cuota: no new slot keys, so the landed
      // packAccounts.ES.slots labels (irpf, seguridad_social) still cover
      // everything and the messages-catalog gate stays green. The cost is
      // one liability account for all SS lines — an operator cannot map
      // contingencias comunes, desempleo, FOGASA, formación and MEI to
      // different accounts until a labels round adds split slots.
      components: [
        // Rate × base de cotización against topes máximos/mínimos — no
        // deduction enters the formula. Employee share settles with the TGSS,
        // a different agency from the AEAT pack vendor, hence external with a
        // per-component destination (the CCC-registered TGSS party).
        { code: "SS-CC", name: "Seguridad Social (employee)", systemKey: "ss_cc", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "external" },
        // Orden PJC/297/2026 art. 33.2.a (indefinida): 1,55 % trabajadora.
        { code: "SS-DES", name: "Desempleo (employee)", systemKey: "ss_des", kind: "deduction", sequence: 121, assessedOn: "earnings", remittance: "external" },
        // Art. 33.2.c: 0,10 % trabajadora.
        { code: "SS-FOR", name: "Formación profesional (employee)", systemKey: "ss_for", kind: "deduction", sequence: 122, assessedOn: "earnings", remittance: "external" },
        // Art. 16: 0,15 % trabajadora.
        { code: "SS-MEI", name: "MEI (employee)", systemKey: "ss_mei", kind: "deduction", sequence: 123, assessedOn: "earnings", remittance: "external" },
        // Art. 4.a: 23,60 % empresa. Distinct systemKey from the employee
        // share — the engine pushes ss_cc_er, never employer-side ss_cc.
        { code: "SS-CC-ER", name: "Seguridad Social (employer)", systemKey: "ss_cc_er", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "external" },
        // Art. 33.2.a (indefinida): 5,5 % empresa.
        { code: "SS-DES-ER", name: "Desempleo (employer)", systemKey: "ss_des_er", kind: "employer_contribution", sequence: 211, assessedOn: "earnings", remittance: "external" },
        // Art. 33.2.b: 0,20 % empresa.
        { code: "SS-FOGASA-ER", name: "FOGASA (employer)", systemKey: "ss_fogasa_er", kind: "employer_contribution", sequence: 212, assessedOn: "earnings", remittance: "external" },
        // Art. 33.2.c: 0,60 % empresa.
        { code: "SS-FOR-ER", name: "Formación profesional (employer)", systemKey: "ss_for_er", kind: "employer_contribution", sequence: 213, assessedOn: "earnings", remittance: "external" },
        // Art. 16: 0,75 % empresa.
        { code: "SS-MEI-ER", name: "MEI (employer)", systemKey: "ss_mei_er", kind: "employer_contribution", sequence: 214, assessedOn: "earnings", remittance: "external" },
      ],
    },
  ],
  computeStatutory: computeEsStatutory,
  statutoryEngineLabel: "AEAT",
  factorLabels: { ...ES_FACTOR_LABELS },
  employeeFacts: ES_EMPLOYEE_FACTS,
};
