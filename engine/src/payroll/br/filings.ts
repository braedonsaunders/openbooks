/**
 * The BR pack's filing declaration: eSocial + DCTFWeb program identity, and
 * the annual Informe de Rendimentos (the Comprovante de Rendimentos Pagos e
 * de Imposto sobre a Renda Retido na Fonte, IN RFB nº 2.060/2021).
 *
 * Declared as one PROGRAM TYPE (the establishment CNPJ the employer reports
 * under) plus one ANNUAL filing:
 * - Monthly payroll events go through eSocial (S-1200 remuneração, S-1210
 *   pagamentos) and settle on DCTFWeb with a DARF Previdenciário / DARF
 *   numerado for IRRF. No event builder exists, so the electronic channels
 *   are refused BY NAME on the informe (eSocial, EFD-Reinf, DCTFWeb).
 * - The annual Comprovante is built off the committed-stub subledger
 *   (./informe.ts): the statement the employee is owed, with the
 *   submission standards honestly refused. For 2024 the figures still
 *   travel on the DIRF; for 2025+ the DIRF is extinta for the year's facts
 *   (IN RFB nº 2.163/2023 art. 3º §1º, as amended by IN RFB nº 2.181/2024)
 *   and remuneration travels on eSocial S-1210 / EFD-Reinf R-4000.
 */
import type { PayrollPackFilings } from "../filing-registry.ts";
import { brInformePopulation, brInformeSlip, parseBrInformeRowId } from "./informe.ts";

export function brPackFilings(): PayrollPackFilings {
  return {
    country: "BR",
    programTypes: [
      {
        key: "br_cnpj_esocial",
        label: "eSocial — CNPJ do estabelecimento",
      },
    ],
    yearEnd: [
      {
        key: "informe",
        label: "Comprovante de Rendimentos Pagos e de Imposto sobre a Renda Retido na Fonte",
        cadence: "annual",
        description:
          "Annual income statement for BR-pack employees (IN RFB nº 2.060/2021): taxable income, "
          + "Previdência Oficial contributions, IRRF withheld and the dependent count, straight off "
          + "committed pay runs. Exempt, exclusive-source and RRA amounts the engine does not price "
          + "are named on the slip, never zeroed.",
        population: (orgId, taxYear) => brInformePopulation(orgId, taxYear),
        parseRowId: parseBrInformeRowId,
        slip: { build: (orgId, taxYear, rowId) => brInformeSlip(orgId, taxYear, rowId) },
        downloadRefusal:
          "the BR pack produces no electronic submission file — for 2024 the channel is the DIRF "
          + "(PGD DIRF, IN RFB nº 1.990/2020) alongside monthly eSocial and EFD-Reinf; for 2025+ "
          + "the channels are eSocial (S-1200 remuneração, S-1210 pagamentos), EFD-Reinf (R-4000 "
          + "series) and DCTFWeb — transmit through those channels directly",
        // A wrong Comprovante is corrected by RE-ISSUING it: the same form,
        // restated from the corrected committed runs (reversals/adjusting
        // entries — posted history is never edited). There is no separate
        // correction form and no cancellation transaction for a statement
        // handed to an employee; the event retification behind the reissue
        // is out of product and named, never built.
        amendment: {
          supported: true,
          revisions: ["amended"],
          vehicle: "same_form",
          downloadRefusal:
            "a corrected Comprovante re-renders from the corrected committed runs, but no "
            + "correction file is produced — for 2024 retify via DIRF retificadora (PGD DIRF); "
            + "for 2025+ retify the eSocial (S-1210) and EFD-Reinf (R-4000) events that replaced "
            + "the DIRF, then re-issue the Comprovante; DCTFWeb follows the retified events",
        },
      },
    ],
  };
}
