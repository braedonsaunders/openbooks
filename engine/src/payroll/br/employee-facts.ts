/**
 * BR required employee facts: the `emp` keys the pack's statutory engine
 * reads, DECLARED with kind, bounds, producer and refusal reason.
 *
 * One source, two readers: `./pack.ts` states it as the pack's
 * `employeeFacts` declaration, and `./compute-statutory.ts` imports this
 * module so every read registers before it can run. See
 * `../employee-facts.ts` for the shape and the derivation of `payable`.
 */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

// Required employee facts. The compute path reads three `emp[...]` keys
  // and NO surface produces any of them — and this pack deliberately
  // declares NO withholding certificate (there is no employee-filed form
  // for IRRF/INSS; saying so is a statement, not a gap). The author
  // expected these facts on the payroll profile, where they were never
  // added — careful authorship with the intent written down, and still
  // blocked. Only dependentes blocks every employee; pensão defaults to
  // none ordered and regime defaults to standard monthly CLT. Declared
  // here with no producers yet, so readiness names the gap before
  // calculation and `payable` derives false until the next shard builds
  // the profile channels.
  export const BR_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
    {
      key: "br_dependentes",
      kind: "count",
      min: 0,
      label: "Dependentes (eSocial cadastro)",
      refusalReason:
        "The R$ 189,59 dependent deduction needs the count — it is never defaulted.",
      required: true,
      producer: {
        kind: "none",
        notes:
          "No channel exists. The eSocial cadastro already carries this as an employer-held cadastre "
          + "fact, which is where the pack author expected it (br/certificates.ts) — but the payroll "
          + "profile was never given the column. OPEN QUESTION: which cadastre artefact the operator "
          + "copies (eSocial evento de admissão/cadastro, outro)? RFB/eSocial citation required before "
          + "building.",
      },
    },
    {
      key: "br_pensao_mensal",
      kind: "amount",
      label: "Pensão alimentícia mensal (court-ordered)",
      refusalReason:
        "Court-ordered alimony reduces the IRRF base; absent means none was ordered, so absence is "
        + "accepted rather than refused.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "No channel exists, and none is needed for the common case: absent means no alimony was "
          + "ordered, so this fact does not block `payable`. When the profile input is built (same "
          + "form as dependentes), declare the profile-column producer here.",
      },
    },
    {
      key: "br_regime",
      kind: "choice",
      choices: ["clt"],
      label: "Regime (CLT mensal padrão)",
      refusalReason:
        "Aprendiz (2% FGTS), doméstico, temporário and other regimes price differently; only a "
        + "present-but-foreign value refuses, while absent is accepted as standard monthly CLT.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "No channel exists, and none is needed for the common case: absent is accepted as standard "
          + "monthly CLT, so this fact does not block `payable`. A fuller regime vocabulary "
          + "(aprendiz, doméstico, temporário — today all refused by name) needs eSocial-table "
          + "citations before it is declared; until then the choice stays [clt].",
      },
    },
];

registerEmployeeFacts("BR", BR_EMPLOYEE_FACTS);
