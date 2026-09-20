/**
 * The BR pack's filing declaration: eSocial + DCTFWeb, monthly.
 *
 * Declared as one PROGRAM TYPE (the establishment CNPJ the employer reports
 * under), with no year-end builders yet:
 * - Monthly payroll events go through eSocial (S-1200 remuneração, S-1210
 *   pagamentos) and settle on DCTFWeb with a DARF Previdenciário / DARF
 *   numerado for IRRF. No event builder exists, so nothing beyond the
 *   program type is declared.
 * - The annual Informe de Rendimentos (ex-DIRF, now eSocial + EFD-Reinf
 *   fed) has no builder: `yearEnd` is empty rather than approximate.
 */
import type { PayrollPackFilings } from "../filing-registry.ts";

export function brPackFilings(): PayrollPackFilings {
  return {
    country: "BR",
    programTypes: [
      {
        key: "br_cnpj_esocial",
        label: "eSocial — CNPJ do estabelecimento",
      },
    ],
    yearEnd: [],
  };
}
