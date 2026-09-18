/**
 * The Italy payroll pack: 2025 computes end to end.
 *
 * Declares every statutory levy Italy withholds or accrues on dependent
 * employment — national IRPEF, the domicile region's addizionale regionale,
 * the domicile comune's addizionale comunale, and INPS employee/employer
 * contributions — plus the CU/770 filings, the detrazioni certificate, the
 * 20-region coverage, and the national festivity calendar.
 *
 * `installable: true` for 2025 (transcribed in tax-year-2025.ts, proven by
 * the tax-year-2025 goldens); 2026 is refused by name (see rates.ts —
 * L. 199/2025 rewrote the second IRPEF bracket and the AdE page is
 * internally inconsistent).
 *
 * Known integration gap (refused by name, not approximated): workers owed a
 * trattamento integrativo or c. 4 somma payout refuse in the statutory pass
 * because pushStatutory has no earnings-credit line kind — the amounts would
 * otherwise travel as factors while no stub line pays them. Clears when the
 * generic layer accepts credit lines (FLEET-PROPOSE to Orchestrate, owned
 * outside this pack); the pure engine already computes both payouts.
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
  installable: true,
  // IRPEF produces EUR; the Italian tax year is the calendar year
  // (periodo d'imposta = anno solare).
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: {
    label: "regione",
    known: IT_REGION_CODES,
    // Stays [] by choice, not by gap: the addizionale regionale is a
    // tenant-declared rate, not a withholding table per region, so no region
    // has "its own tables" to support — the engine computes every domicile
    // identically from the declared rate (withholding.implemented is true
    // for all 20). Listing regions here would claim per-region tables exist.
    supported: [],
    unsupportedReason:
      "no IT regione publishes its own withholding tables: the addizionale regionale/comunale for "
      + "{region} computes from the tenant-declared rate (see engine/src/payroll/it/rates.ts), so the "
      + "region is not listed as supported — the engine still withholds for it once the rate is entered.",
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
