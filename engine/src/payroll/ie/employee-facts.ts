import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

export const IE_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
  {
    key: "ie_prsi_class",
    kind: "code",
    label: "PRSI class",
    refusalReason:
      "The class determines employee and employer PRSI; missing status must not be priced as Class A.",
    required: true,
    producer: { kind: "certificate", certificate: "ie_prsi_class", field: "prsi_class" },
  },
];

registerEmployeeFacts("IE", IE_EMPLOYEE_FACTS);
