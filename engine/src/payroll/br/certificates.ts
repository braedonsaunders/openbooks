/**
 * The BR pack's withholding certificates: none — and that is a statement.
 *
 * Brazil has no employee-filed withholding certificate for IRRF/INSS. What
 * other packs read off a certificate (family data, pension flags) arrives
 * here as employer-held cadastre facts on the payroll profile
 * (`br_dependentes`, `br_pensao_mensal`), which the eSocial cadastro already
 * carries. Declaring an empty certificate list says "no form exists";
 * silence would invite somebody to invent one.
 */
import type { PayrollPackCertificates } from "../certificates.ts";

export const BR_CERTIFICATES: PayrollPackCertificates = {
  country: "BR",
  certificates: [],
};
