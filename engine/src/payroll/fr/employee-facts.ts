import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

/** Required statutory inputs for the 2026 RGDU path. */
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
