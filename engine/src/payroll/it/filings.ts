/**
 * The IT pack's filing declaration: the two sostituto d'imposta filings.
 *
 * - CU (Certificazione Unica): the employer-as-sostituto certifies each
 *   employee's dependent-employment income and the IRPEF, addizionali and
 *   INPS withheld, delivers it to the percipiente and transmits it to the
 *   Agenzia delle Entrate (CU 2026, tax year 2025: AdE Provvedimento n. 15707
 *   del 15 gennaio 2026).
 * - Modello 770: the sostituto's annual declaration of the withholdings
 *   operated and paid (770/2026, tax year 2025: AdE Provvedimento n. 72221
 *   del 2026).
 *
 * Both are DECLARED (keys, cadence, correction posture, download refusals)
 * but not populated: no engine computes the numbers yet, so population
 * refuses by name instead of printing zeros an employer might file. Row
 * grammars and slips arrive with the builders, never ahead of them.
 */
import { PayrollError } from "../error.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollPackFilings,
} from "../filing-registry.ts";

export class ItFilingRefusal extends PayrollError {}

function refusePopulation(filing: string, year: number): Promise<PayrollFilingData> {
  return Promise.reject(
    new ItFilingRefusal(
      `the IT payroll pack declares the ${filing} filing but cannot populate it for tax year ${year}: `
      + "no tax-year edition is transcribed (see engine/src/payroll/it/rates.ts). "
      + "Withholding tables must be transcribed before this filing can report committed stubs.",
    ),
  );
}

/** No rows exist while population refuses, so no row id parses. */
function refuseRowId(): PayrollFilingRowScope | null {
  return null;
}

export const IT_PACK_FILINGS: PayrollPackFilings = {
  country: "IT",
  programTypes: [
    {
      key: "it_sostituto",
      label: "Codice fiscale del sostituto d'imposta",
    },
  ],
  yearEnd: [
    {
      key: "cu",
      label: "Certificazione Unica",
      cadence: "annual",
      description:
        "Certificazione Unica dei redditi di lavoro dipendente e delle ritenute operate, "
        + "rilasciata dal sostituto d'imposta al percipiente e trasmessa all'Agenzia delle Entrate.",
      emptyText: "No committed IT pay stubs for this year.",
      population: (_orgId, taxYear) => refusePopulation("Certificazione Unica", taxYear),
      parseRowId: () => refuseRowId(),
      downloadRefusal:
        "the IT pack produces no Entratel CU telematic file — the slip data is not computed; "
        + "transmit the Certificazione Unica through the Agenzia delle Entrate's own channels",
      amendment: {
        supported: false,
        refusal:
          "the CU correction vehicle (tipi di comunicazione sostitutiva/annullamento) is not "
          + "transcribed by the IT pack — a corrected CU cannot be produced here",
      },
    },
    {
      key: "770",
      label: "Modello 770 — Dichiarazione dei sostituti d'imposta",
      cadence: "annual",
      description:
        "Annual declaration by which the sostituto d'imposta reports the withholdings operated "
        + "on dependent-employment income and the payments made with Modello F24.",
      emptyText: "No committed IT pay stubs for this year.",
      population: (_orgId, taxYear) => refusePopulation("Modello 770", taxYear),
      parseRowId: () => refuseRowId(),
      downloadRefusal:
        "the IT pack produces no Entratel 770 telematic file — the declaration data is not computed; "
        + "file Modello 770 through the Agenzia delle Entrate's own channels",
      amendment: {
        supported: false,
        refusal:
          "the 770 correttiva/integrativa mechanics are not transcribed by the IT pack — "
          + "a corrected 770 cannot be produced here",
      },
    },
  ],
};

/** Lazy, like every pack's filings declaration: not dereferenced at module-evaluation time. */
export function itPackFilings(): PayrollPackFilings {
  return IT_PACK_FILINGS;
}
