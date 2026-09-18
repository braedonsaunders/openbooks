/**
 * The España payroll pack (SKELETON — `installable: false`).
 *
 * Declares IRPF withholding (AEAT) and Seguridad Social employee + employer
 * contributions (TGSS) as statutory slots, the Modelo 145 certificate, the
 * 19-community region coverage with foral refusals, and the national holiday
 * calendar. No 2026 table is transcribed — the AEAT algorithm and the TGSS
 * Orden de cotización were fetched and cited per module, and the pack refuses
 * every calculation until a sourced-table pass lands them in ./rates.ts.
 *
 * REGISTRATION is blocked on the generic layer: `PayrollCountry` is still
 * `"CA" | "US"` (packs.ts:190), so this object is typed WITHOUT the union —
 * `Omit<PayrollCountryPack, "country"> & { country: "ES" }` — which proves it
 * is structurally registerable the moment Orchestrate opens the type (see
 * packs/proposals/payroll-country-union.md, owned by gb-payroll — no second
 * propose sent). Nothing here is registered: no `packs.ts` edit, no registry
 * side effect, no settings key wired.
 */
import type {
  PayrollCountryPack,
  PayrollRegionCoverage,
} from "../packs.ts";
import { ES_CERTIFICATES } from "./certificates.ts";
import { computeEsStatutory } from "./compute-statutory.ts";
import { esPackFilings } from "./filings.ts";
import { ES_JURISDICTIONS } from "./jurisdictions.ts";
import { ES_PACK_RATES, ES_TAX_YEARS } from "./rates.ts";
import { ES_WITHHOLDING } from "./withholding.ts";

/** Structural conformance without the closed union (see module doc). */
export type EsPayrollPack = Omit<PayrollCountryPack, "country"> & {
  country: "ES";
};

const ES_REGIONS: PayrollRegionCoverage = {
  label: "autonomous community",
  known: [
    "AN", "AR", "AS", "CN", "CB", "CL", "CM", "CT", "EX", "GA",
    "IB", "RI", "MD", "MC", "NC", "PV", "VC", "CE", "ML",
  ],
  // Nothing transcribed (see ./rates.ts) — not even AEAT territory.
  supported: [],
  unsupportedReason:
    "IRPF withholding for {region} is not implemented by the ES payroll pack — the AEAT "
    + "retention algorithm for the year is not transcribed into engine/src/payroll/es/rates.ts",
  unsupportedReasons: {
    NC: "Navarra applies the foral IRPF regime: Hacienda Foral de Navarra publishes its own "
      + "retention tables, which are not transcribed — AEAT tables never cover Navarra",
    PV: "the Basque Historical Territories — Álava/Araba, Gipuzkoa and Bizkaia — apply the "
      + "foral IRPF regime: each Hacienda Foral publishes its own retention tables, which are "
      + "not transcribed — AEAT tables never cover them",
  },
};

export const ES_PAYROLL_PACK: EsPayrollPack = {
  country: "ES",
  installable: false,
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
      components: [
        // Rate × base de cotización against topes máximos/mínimos — no
        // deduction enters the formula. Employee share settles with the TGSS,
        // a different agency from the AEAT pack vendor, hence external with a
        // per-component destination (the CCC-registered TGSS party).
        { code: "SS-CC", name: "Seguridad Social (employee)", systemKey: "ss_cc", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "external" },
        { code: "SS-CC-ER", name: "Seguridad Social (employer)", systemKey: "ss_cc", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "external" },
      ],
    },
  ],
  computeStatutory: computeEsStatutory,
  statutoryEngineLabel: "AEAT",
};
