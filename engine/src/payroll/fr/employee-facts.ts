import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

/** Required statutory inputs for the 2026 RGDU path, plus the CDD contract flag for CPF-CDD. */
export const FR_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
  {
    key: "fr_rgdu_eligible",
    kind: "choice",
    label: "RGDU employee eligibility",
    choices: ["eligible", "excluded"],
    refusalReason:
      "CSS article L.241-13 excludes specific employment categories; the engine must know the employee's declared eligibility before reducing employer contributions",
    required: true,
    producer: { kind: "certificate", certificate: "fr_pas_option", field: "rgdu_eligibility" },
  },
  {
    key: "fr_contrat_cdd",
    kind: "flag",
    label: "Contrat à durée déterminée (CDD)",
    refusalReason:
      "Only a present-but-foreign value refuses; absent is accepted as an indefinite (CDI) contract.",
    required: false,
    producer: {
      kind: "none",
      notes:
        "No channel exists yet: the contract type needs a profile column (migration) or an "
        + "employment-contract certificate field, neither of which this change ships. Until then "
        + "absent is accepted as a CDI — the es_contrato_temporal precedent — so a CDD case with "
        + "no declared flag prices no CPF-CDD rather than refusing without remedy.",
    },
  },
  {
    key: "fr_rgdu_regular_hours",
    kind: "amount",
    label: "Contractual or worked hours in the RGDU period",
    refusalReason:
      "CSS D.241-7 IV adjusts the annual SMIC to contractual hours, presence, and eligible extra hours; record a work schedule or approved time entries for this period",
    required: false,
    producer: {
      kind: "derivation",
      derivation: "FR payroll period hours",
      notes: "Resolved for each period from the effective work schedule or approved time entries, then validated through resolveEmployeeFact.",
    },
  },
];

registerEmployeeFacts("FR", FR_EMPLOYEE_FACTS);
