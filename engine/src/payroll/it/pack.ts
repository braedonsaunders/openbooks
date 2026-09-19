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
 * The trattamento integrativo and c. 4 somma payouts travel as generic
 * `credit` lines (kind `credit`, assessed on earnings, remitted to the tax
 * authority for F24 compensation): money the employer pays the employee and
 * reclaims. They sit in the IRPEF slot because the reclaim lands on the same
 * F24 liability the withholdings credit — one destination, one account
 * choice, and the remittance summary nets them against it.
 *
 * REGISTERED: `PayrollCountry` is the registry's own keys, so `country: "IT"`
 * typechecks directly. (Written while the union was closed, typed as the full
 * `PayrollCountryPack` minus that member to prove conformance.)
 */
import type { PayrollCountryPack } from "../packs.ts";
import { IT_CERTIFICATES } from "./certificates.ts";
import { computeItStatutory, IT_FACTOR_LABELS } from "./compute-statutory.ts";
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
  name: "Italy",
  // Agenzia delle Entrate: the codice fiscale is a 16-character alphanumeric
  // code (surname, name, birth year/month/sex, birthplace code, check
  // letter). The numeric slots tolerate letters: omocodia substitutes
  // L–W for digits, so a digits-only pattern would reject valid codes.
  // No check letter is enforced (unsourced here). Needed for the
  // Certificazione Unica.
  employeeIdentifier: {
    label: "codice fiscale",
    pattern: "[A-Z]{6}[A-Z0-9]{2}[A-Z][A-Z0-9]{2}[A-Z][A-Z0-9]{3}[A-Z]",
    formatHelp: "16 alphanumeric characters",
    example: "RSSMRA85T10A562S",
    requiredForPayroll: true,
    neededFor: "Certificazione Unica",
    citation: "Agenzia delle Entrate: the codice fiscale is a 16-character alphanumeric code (DPR 605/1973)",
    numericEntry: false,
  },
  installable: true,
  // IRPEF produces EUR; the Italian tax year is the calendar year
  // (periodo d'imposta = anno solare).
  statutoryCurrency: "EUR",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: {
    label: "regione",
    known: IT_REGION_CODES,
    // All 20, because `supported` asks whether the ENGINE computes the
    // region's income tax end to end — not whether the region publishes its
    // own withholding tables. It does: IRPEF nationally, plus the addizionale
    // regionale/comunale from the tenant-declared rate, identically for every
    // domicile (withholding.implemented is true for all 20, and these two
    // fields are the same fact — see installable-region-coverage.test.ts).
    //
    // Reading it as "publishes its own tables" left this [] while the pack was
    // installable, and Link 4 of resolveEmployeePayrollContext calls
    // assertPayrollRegionSupported UNCONDITIONALLY — so every Italian employee
    // threw before a single line was computed. Declining the opt-in
    // ctx.assertRegionSupported callback (which this engine does, for its own
    // reasons) does not exempt a pack from that gate.
    //
    // An unconfigured addizionale rate is still refused, in compute-statutory
    // by scope point. That is the right layer: a missing rate is one region's
    // missing datum, while an unsupported region refuses the whole payroll.
    supported: IT_REGION_CODES,
    unsupportedReason:
      "income tax withholding for regione {region} is not implemented: the IT pack computes IRPEF "
      + "plus the addizionale regionale/comunale for every ISTAT regione, so reaching this message "
      + "means {region} is not a known ISTAT code.",
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
        // The TI and c. 4 somma payouts: refundable credits the employer pays
        // the worker and recovers through the F24. Earnings-assessed (computed
        // from gross), pushed once, never re-derived by the protection
        // fixpoint — exactly like an earnings line. They INCREASE net pay.
        { code: "TI", name: "Trattamento integrativo", systemKey: "ti_payout", kind: "credit", sequence: 140, assessedOn: "earnings", remittance: "tax_authority" },
        { code: "SOMMA", name: "Somma di cui al comma 4 (L. 207/2024)", systemKey: "somma_payout", kind: "credit", sequence: 145, assessedOn: "earnings", remittance: "tax_authority" },
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
  factorLabels: { ...IT_FACTOR_LABELS },
  // The withholding computation lives under the sostituto statute itself; no
  // single named table publication exists until the first edition lands.
  statutoryEngineLabel: "DPR 600/1973",
};
