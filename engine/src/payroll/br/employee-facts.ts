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

// Required employee facts. The compute path reads three `emp[...]` keys.
  // This pack still declares NO employee-filed withholding certificate
  // (there is none for IRRF/INSS; saying so is a statement, not a gap) —
  // the `br_cadastro` declaration is the employer-held cadastre facts made
  // explicit, not a form. Dependentes and pensão are served since 0191 by
  // the profile columns it maps; regime stays unbuilt (absent is accepted
  // as standard monthly CLT). Only dependentes blocks, so only it moves
  // `payable`; pensão without a column would have left the deduction
  // unreachable, which is why it ships in the same channel.
  //
  // OPEN, still: which cadastre artefact the operator copies (eSocial
  // evento de admissão/cadastro, outro). This channel carries the values;
  // the RFB/eSocial citation for the artefact is still owed.
  export const BR_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
    {
      key: "br_dependentes",
      kind: "count",
      min: 0,
      label: "Dependentes (eSocial cadastro)",
      refusalReason:
        "The R$ 189,59 dependent deduction needs the count — it is never defaulted.",
      required: true,
      producer: { kind: "profile_column", column: "br_dependentes" },
    },
    {
      key: "br_pensao_mensal",
      kind: "amount",
      label: "Pensão alimentícia mensal (court-ordered)",
      refusalReason:
        "Court-ordered alimony reduces the IRRF base; absent means none was ordered, so absence is "
        + "accepted rather than refused.",
      required: false,
      producer: { kind: "profile_column", column: "br_pensao_mensal" },
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
