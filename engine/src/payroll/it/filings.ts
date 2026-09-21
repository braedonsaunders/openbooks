/**
 * The IT pack's filing declaration: the two sostituto d'imposta filings.
 *
 * - CU (Certificazione Unica): the employer-as-sostituto certifies each
 *   employee's dependent-employment income and the IRPEF, addizionale
 *   regionale and INPS withheld, delivers it to the percipiente and
 *   transmits it to the Agenzia delle Entrate (CU 2026, tax year 2025: AdE
 *   Provvedimento n. 15707 del 15 gennaio 2026). Populated off the year's
 *   committed stubs — see ./cu.ts for the box-by-box citation.
 * - Modello 770: the sostituto's annual declaration of the withholdings
 *   operated and paid (770/2026, tax year 2025: AdE Provvedimento n. 72221
 *   del 2026). Declared but not populated: the employer's own annual return
 *   is a different transcription (its quadri reconcile sostituto-level F24
 *   payments, not per-employee slips), so population refuses by name instead
 *   of printing zeros an employer might file.
 */
import type {
  PayrollPackFilings,
} from "../filing-registry.ts";
import {
  CU_SUPPORTED_TAX_YEAR,
  ItFilingRefusal,
  cuPopulation,
  cuSlip,
  parseCuRowId,
} from "./cu.ts";

export { ItFilingRefusal };

function refusePopulation(filing: string, year: number): Promise<never> {
  return Promise.reject(
    new ItFilingRefusal(
      `the IT payroll pack declares the ${filing} filing but cannot populate it for tax year ${year}: `
      + "no filing population is transcribed (see engine/src/payroll/it/rates.ts). "
      + "Withholding tables must be transcribed before this filing can report committed stubs.",
    ),
  );
}

/** No rows exist while population refuses, so no row id parses. */
function refuseRowId(): null {
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
      population: (orgId, taxYear) => cuPopulation(orgId, taxYear),
      parseRowId: (rowId) => parseCuRowId(rowId),
      slip: { build: (orgId, taxYear, rowId) => cuSlip(orgId, taxYear, rowId) },
      downloadRefusal:
        "the IT pack produces no Entratel CU telematic file (Specifiche tecniche CU 2026) — "
        + "the slip data above is complete; transmit the Certificazione Unica through the Agenzia "
        + "delle Entrate's own channels",
      // A wrong CU is corrected with a new CU comunicazione barring
      // Sostituzione (or Annullamento to withdraw it), never by editing the
      // original — CU 2026 istruzioni §3.1 "Tipo di comunicazione". This pack
      // produces the original slip only, so the correction names its real
      // out-of-product vehicle.
      amendment: {
        supported: false,
        refusal:
          "a wrong CU is corrected only by re-transmitting a CU comunicazione barring Sostituzione "
          + "(or Annullamento to withdraw it) via Entratel — CU 2026 istruzioni §3.1 Tipo di comunicazione, "
          + "in a new comunicazione carrying only the replaced or withdrawn certifications. "
          + "This pack produces the original slip and no sostitutiva/annullamento file: prepare the "
          + "correction in the Agenzia delle Entrate's own channel before the presentation deadline.",
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

export { CU_SUPPORTED_TAX_YEAR };
