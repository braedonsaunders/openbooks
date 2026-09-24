/** Required GB payroll facts consumed by the statutory engine. */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

export const GB_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
  {
    key: "gb_student_loan_plan",
    kind: "choice",
    choices: ["none", "plan_1", "plan_2", "plan_4", "plan_5"],
    label: "student loan plan",
    refusalReason:
      "The plan determines its threshold and repayment; the engine must not infer a plan or omit a selected repayment.",
    required: true,
    producer: { kind: "certificate", certificate: "gb_starter_checklist", field: "student_loan_plan" },
  },
  {
    key: "gb_postgraduate_loan",
    kind: "flag",
    label: "postgraduate loan status",
    refusalReason:
      "A postgraduate loan can coexist with a student loan and has a separate threshold and rate.",
    required: true,
    producer: {
      kind: "certificate",
      certificate: "gb_starter_checklist",
      field: "student_loan_postgraduate",
    },
  },
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
