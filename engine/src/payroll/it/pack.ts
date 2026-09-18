/**
 * The Italy payroll pack (skeleton).
 *
 * Declares every statutory levy Italy withholds or accrues on dependent
 * employment — national IRPEF, the domicile region's addizionale regionale,
 * the domicile comune's addizionale comunale, and INPS employee/employer
 * contributions — plus the CU/770 filings, the detrazioni certificate, the
 * 20-region coverage (all refused until transcribed), and the national
 * festivity calendar.
 *
 * `installable: false` until a tax year is transcribed: 2026 is refused by
 * name (see rates.ts — L. 199/2025 rewrote the second IRPEF bracket and the
 * AdE page is internally inconsistent). Nothing here computes; the
 * statutory pass refuses with the year and the missing module.
 *
 * Registration shape: `country` is the string "IT", which does not yet
 * typecheck against `PayrollCountry` (packs.ts:190, still 'CA' | 'US'). The
 * pack is therefore typed as the full `PayrollCountryPack` minus the closed
 * union member, so it registers unchanged the moment Orchestrate opens the
 * type (packs/proposals/payroll-country-union.md, owned by gb-payroll —
 * this shard sends no second propose for it). Nothing outside
 * engine/src/payroll/it/ is touched.
 */
import type { PayrollCountryPack } from "../packs.ts";
import { IT_CERTIFICATES } from "./certificates.ts";
import { computeItStatutory } from "./compute-statutory.ts";
import { itPackFilings } from "./filings.ts";
import { IT_JURISDICTIONS } from "./jurisdictions.ts";
import { IT_PACK_RATES, IT_TAX_YEARS } from "./rates.ts";
import { IT_REGION_CODES } from "./regions.ts";
import { IT_WITHHOLDING } from "./withholding.ts";

/** The pack declaration minus the still-closed country union member. */
export type ItPayrollPackDeclaration = Omit<PayrollCountryPack, "country"> & {
  country: "IT";
};

export const IT_PAYROLL_PACK: ItPayrollPackDeclaration = {
  country: "IT",
  installable: false,
  // IRPEF produces EUR; the Italian tax year is the calendar year
  // (periodo d'imposta = anno solare).
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: {
    label: "regione",
    known: IT_REGION_CODES,
    // DERIVED in spirit: nothing is transcribed, so every withholding entry
    // is implemented:false and nothing is supported. A region gains support
    // by transcribing its surcharge tables, never by editing this list.
    supported: [],
    unsupportedReason:
      "addizionale regionale/comunale withholding for {region} is not implemented by the IT payroll "
      + "pack: no tax-year edition is transcribed, so the region's surcharge tables cannot be computed. "
      + "See engine/src/payroll/it/rates.ts.",
  },
  jurisdictions: IT_JURISDICTIONS,
  // Withholdings are paid through Modello F24 to the Agenzia delle Entrate —
  // there is no single org-configured vendor party of the CRA kind, so the
  // pack declares none and its tax_authority lines surface unassigned until
  // per-component destinations are set. The F24 monthly cadence (D.Lgs. 9
  // luglio 1997, n. 241) is not transcribed as schedule data yet.
  remittanceVendorSettingsKey: null,
  // Arretrati for prior years fall under art. 17 TUIR tassazione separata
  // (average-rate separate taxation) — a regime this channel cannot name yet
  // (proposed to Orchestrate as a third value). non_periodic is declared
  // because annualising prior-year arrears as current-period income is the
  // wrong computation; the gap is documented, not worked around.
  retroactivePayTreatment: "non_periodic",
  contributoryBases: {
    pensionable: "INPS pensionable earnings (retribuzione imponibile previdenziale, IVS/FPLD)",
    // Refused in prose: Italy has no second compulsory contribution pillar,
    // so the insurable flag accumulates nothing under this pack and no engine
    // may read it as a distinct base.
    insurable: "no distinct base — Italy levies no second compulsory contribution; flag unused",
  },
  // Union dues ride the pay slip via delega sindacale, but whether art. 10
  // TUIR deducts them was not established in this pass — so null (no tax
  // treatment) until sourced, never a guessed factor.
  employeeUnionDuesTaxTreatment: null,
  filings: itPackFilings,
  statutoryRates: IT_PACK_RATES,
  taxYears: IT_TAX_YEARS,
  certificates: () => IT_CERTIFICATES,
  withholding: () => IT_WITHHOLDING,
  // No inter-regional withholding agreements exist under the national
  // sostituto mechanism; absent resolves to no agreement.
  statutorySlots: [
    {
      key: "irpef",
      components: [
        // IRPEF is assessed on reddito complessivo net of oneri deducibili,
        // so a pre-tax deduction moves it — re-derived by the fixpoint.
        { code: "IRPEF", name: "IRPEF — imposta sul reddito delle persone fisiche", systemKey: "income_tax", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "addizionale_regionale",
      components: [
        // Same base as IRPEF (the domicile region's surcharge on the IRPEF
        // taxable income), remitted through the same F24.
        { code: "ADDREG", name: "Addizionale regionale all'IRPEF", systemKey: "regional_surtax", kind: "deduction", sequence: 115, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "addizionale_comunale",
      components: [
        // The domicile comune's surcharge (acconto + saldo mechanics live in
        // the untranscribed tables, not in the slot).
        { code: "ADDCOM", name: "Addizionale comunale all'IRPEF", systemKey: "municipal_surtax", kind: "deduction", sequence: 120, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "inps",
      components: [
        // IVS contributions are rate × retribuzione imponibile; no deduction
        // enters the formula, both shares.
        { code: "INPS", name: "INPS — contributi IVS a carico del lavoratore", systemKey: "inps", kind: "deduction", sequence: 130, assessedOn: "earnings", remittance: "tax_authority" },
        { code: "INPS-ER", name: "INPS — contributi IVS a carico del datore", systemKey: "inps", kind: "employer_contribution", sequence: 230, assessedOn: "earnings", remittance: "tax_authority" },
      ],
    },
  ],
  computeStatutory: computeItStatutory,
  // The withholding computation lives under the sostituto statute itself; no
  // single named table publication exists until the first edition lands.
  statutoryEngineLabel: "DPR 600/1973",
};
