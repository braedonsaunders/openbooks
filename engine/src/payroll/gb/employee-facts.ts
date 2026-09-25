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
  {
    key: "gb_ae_age_band",
    kind: "choice",
    choices: ["under_22", "22_to_state_pension_age", "state_pension_age_or_over"],
    label: "worker age band for automatic enrolment",
    refusalReason: "The employer's automatic-enrolment duties depend on the worker's age band.",
    required: true,
    producer: { kind: "certificate", certificate: "gb_workplace_pension_assessment", field: "age_band" },
  },
  {
    key: "gb_ae_membership_status",
    kind: "choice",
    choices: ["not_eligible", "active_member", "valid_opt_out"],
    label: "workplace pension membership status",
    refusalReason: "The engine must know whether automatic-enrolment contributions are due.",
    required: true,
    producer: {
      kind: "certificate", certificate: "gb_workplace_pension_assessment", field: "membership_status",
    },
  },
  {
    key: "gb_ae_scheme_basis",
    kind: "choice",
    choices: ["not_applicable", "qualifying_earnings_minimum", "other_basis"],
    label: "workplace pension contribution basis",
    refusalReason: "The qualifying-earnings band and contribution basis determine the amount due.",
    required: true,
    producer: {
      kind: "certificate", certificate: "gb_workplace_pension_assessment", field: "scheme_basis",
    },
  },
  {
    key: "gb_ae_deduction_method",
    kind: "choice",
    choices: ["not_applicable", "net_pay", "relief_at_source", "salary_sacrifice"],
    label: "workplace pension employee contribution method",
    refusalReason: "The method changes employee withholding and tax treatment.",
    required: true,
    producer: {
      kind: "certificate", certificate: "gb_workplace_pension_assessment", field: "deduction_method",
    },
  },
];

registerEmployeeFacts("GB", GB_EMPLOYEE_FACTS);
