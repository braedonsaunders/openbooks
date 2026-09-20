/**
 * The BR pack's withholding certificates: no employee-filed form — and that
 * is a statement. What other packs read off a certificate (family data,
 * pension flags) arrives here as employer-held cadastre facts on the
 * payroll profile (`br_dependentes`, `br_pensao_mensal`), which the eSocial
 * cadastro already carries.
 *
 * The cadastre declaration below is NOT a withholding certificate and must
 * never be read as one: it declares no form an employee files, and the
 * row-backed certificate surface (POST /api/payroll/certificates) serves
 * only `certificate_rows` declarations, so nothing here can be "filed".
 * It exists because the profile-column producer channel is validated
 * against the typed certificate declarations — a column no certificate
 * field maps is not a producer — and these facts belong to no form at all.
 * Inventing a form number for them would be worse than this explicit
 * non-form declaration.
 */
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";

const BR_CADASTRO: PayrollCertificate = {
  key: "br_cadastro",
  // Not a form and not filed: the employer-held cadastre facts the IRRF
  // engine prices, named for where the operator copies them from.
  form: "Cadastro (eSocial)",
  label: "Dependentes and pensão alimentícia (eSocial cadastro)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "eSocial cadastro (employer-held; evento de admissão/cadastro); Lei 9.250/1995 art. 4º/10 "
    + "(R$ 189,59 dependent deduction, 25% simplified discount); court order for pensão alimentícia",
  summary:
    "The dependent count the R$ 189,59 IRRF deduction needs, and any court-ordered monthly "
    + "alimony reducing the IRRF base. No employee-filed form exists for either.",
  storage: "profile_columns",
  fields: [
    {
      key: "dependentes",
      label: "Dependentes (eSocial cadastro)",
      kind: "count",
      min: "0",
      storage: { kind: "column", column: "br_dependentes" },
      // Required: the engine prices no BR employee without it — but an
      // UNANSWERED profile still saves, so readiness names the gap before
      // calculation rather than the save refusing an incomplete setup.
      required: true,
      help: "The dependent count the R$ 189,59 deduction needs — copied off the eSocial cadastro, "
        + "never defaulted.",
    },
    {
      key: "pensao_mensal",
      label: "Pensão alimentícia mensal (court-ordered)",
      kind: "amount",
      decimals: 4,
      min: "0",
      storage: { kind: "column", column: "br_pensao_mensal" },
      help: "Court-ordered monthly alimony reducing the IRRF base. Absent means none was ordered — "
        + "accepted, not refused.",
    },
  ],
};

export const BR_CERTIFICATES: PayrollPackCertificates = {
  country: "BR",
  certificates: [BR_CADASTRO],
};
