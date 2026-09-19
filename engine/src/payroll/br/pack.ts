/**
 * The Brasil payroll pack (`installable: true` — 2026 computes end to end
 * and the adapter golden pushes all six lines through the
 * declaration-enforcing push path; BR slot labels landed in English).
 *
 * Declares IRRF monthly withholding (Receita Federal) and the employee INSS
 * contribution (RGPS) as statutory slots, the employer INSS cost (patronal
 * 20%, RAT × FAP, terceiros) from tenant-declared establishment rates, the
 * FGTS 8% employer obligation, the national region coverage with no
 * certificate (dependents arrive as cadastre facts), and the national
 * feriado calendar. Calendar 2026 is transcribed — the Portaria 13/2026
 * INSS brackets and the IRRF monthly table + art. 3º-A reduction live in
 * ./tax-year-2026.ts and computeStatutory prices a monthly CLT payslip
 * through them.
 *
 * REGISTERED: `PayrollCountry` is `keyof typeof PAYROLL_COUNTRY_PACKS`, so
 * this pack is in the registry, wired to its settings keys, and installable.
 */
import type { PayrollCountryPack } from "../packs.ts";
import { BR_CERTIFICATES } from "./certificates.ts";
import { computeBrStatutory } from "./compute-statutory.ts";
import { brPackFilings } from "./filings.ts";
import { BR_JURISDICTIONS } from "./jurisdictions.ts";
import { BR_PACK_RATES, BR_TAX_YEARS } from "./rates.ts";
import { BR_WITHHOLDING } from "./withholding.ts";

export const BR_PAYROLL_PACK: PayrollCountryPack = {
  country: "BR",
  installable: true,
  // The BR pack computes in reais; IRRF, INSS and FGTS settle in reais.
  statutoryCurrency: "BRL",
  // The IRPF ano-calendário is the calendar year (Lei 9.250/1995); the INSS
  // portaria reprices every January for remuneration from 1 January.
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  // IRRF and INSS are federal and national: the one known region is the
  // country itself, and it is supported now that the 2026 engine computes
  // end to end (installable and supported are one fact stated twice).
  regions: {
    label: "country",
    known: ["BR"],
    supported: ["BR"],
    unsupportedReason:
      "income tax withholding for {region} is not implemented: the national IRRF table does not compute end to end. "
      + "Transcribe the year's tables into engine/src/payroll/br/ first.",
  },
  jurisdictions: BR_JURISDICTIONS,
  // Two destinations share the money — Receita Federal takes IRRF (DARF),
  // the RGPS takes INSS (DCTFWeb/DARF Previdenciário), Caixa takes FGTS —
  // so no single statutory vendor is named. `tax_authority` withholdings
  // surface unassigned until configured, as with the FR pack; FGTS rides a
  // per-component destination like the ES pack's TGSS lines.
  remittanceVendorSettingsKey: null,
  // IRRF is assessed on the month's accumulated rendimentos (every amount
  // paid in the month joins the base) and INSS on the monthly
  // salary-de-contribuição — a retro amount paid now joins this month, taxed
  // as ordinary income of the period paid. 13º-style exclusive-source timing
  // is a named refusal, not this path.
  retroactivePayTreatment: "periodic",
  contributoryBases: {
    pensionable: "salário-de-contribuição mensal (INSS, EC 103/2019, teto R$ 8.475,55 em 2026)",
    insurable: "remuneração mensal (FGTS, Lei 8.036/1990 art. 15; contribuição patronal, Lei 8.212/1991 art. 22)",
  },
  // Union dues open no withholding treatment: contribuição assistencial is a
  // consensual deduction, never a statutory one.
  employeeUnionDuesTaxTreatment: null,
  filings: brPackFilings,
  statutoryRates: BR_PACK_RATES,
  taxYears: BR_TAX_YEARS,
  certificates: () => BR_CERTIFICATES,
  withholding: () => BR_WITHHOLDING,
  statutorySlots: [
    {
      key: "irrf",
      components: [
        // Lei 9.250/1995 art. 3º-A + monthly table on the base AFTER the
        // art. 4º/10 deductions — a pre-tax protected deduction moves it, so
        // taxable_income, re-derived every fixpoint pass like T4127-T/FIT.
        { code: "IRRF", name: "IRRF", systemKey: "irrf", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "inss",
      components: [
        // EC 103/2019 progressive slices × salary-de-contribuição to the
        // teto — no deduction enters the formula.
        { code: "INSS", name: "INSS (segurado)", systemKey: "inss", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "tax_authority" },
        // Lei 8.212/1991 art. 22, I: 20% on total remuneration, no teto.
        // Distinct systemKey from the employee share — the engine pushes
        // inss_patronal, never employer-side inss.
        { code: "INSS-ER", name: "INSS patronal (20%)", systemKey: "inss_patronal", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
        // Art. 22, II × FAP (Lei 10.666/2003 art. 10): the br_rat/br_fap
        // tenant slots. Refused at lookup when undeclared, never guessed.
        { code: "RAT-ER", name: "RAT × FAP", systemKey: "inss_rat", kind: "employer_contribution", sequence: 211, assessedOn: "earnings", remittance: "tax_authority" },
        // Terceiros (Sistema S / salário-educação / INCRA): the br_terceiros
        // tenant slot for the establishment's FPAS code.
        { code: "TERC-ER", name: "Terceiros", systemKey: "inss_terceiros", kind: "employer_contribution", sequence: 212, assessedOn: "earnings", remittance: "tax_authority" },
      ],
    },
    {
      key: "fgts",
      components: [
        // Lei 8.036/1990 art. 15: 8% deposited to the worker's linked
        // account — an employer obligation, NOT withheld. external with a
        // per-component destination (the Caixa party), like ES's TGSS lines.
        { code: "FGTS", name: "FGTS (8%)", systemKey: "fgts", kind: "employer_contribution", sequence: 220, assessedOn: "earnings", remittance: "external" },
      ],
    },
  ],
  computeStatutory: computeBrStatutory,
  statutoryEngineLabel: "IRRF/INSS",
};
