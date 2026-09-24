/** Required GB payroll facts consumed by the statutory engine. */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

export const GB_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
  {
    key: "gb_nic_category_letter",
    kind: "choice",
    choices: ["A", "B", "C", "D", "E", "F", "H", "I", "J", "K", "L", "M", "N", "S", "V", "X", "Z"],
    label: "National Insurance category letter",
    refusalReason:
      "The letter determines both employee and employer Class 1 NIC; the engine must not assume category A.",
    required: true,
    producer: { kind: "certificate", certificate: "gb_nic_category", field: "category_letter" },
  },
];

registerEmployeeFacts("GB", GB_EMPLOYEE_FACTS);
