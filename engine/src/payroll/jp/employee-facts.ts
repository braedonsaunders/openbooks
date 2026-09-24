/**
 * JP required employee facts: the `emp` keys the pack's statutory engine
 * reads, DECLARED with kind, bounds, producer and refusal reason.
 *
 * One source, two readers: `./pack.ts` states it as the pack's
 * `employeeFacts` declaration, and `./compute-statutory.ts` imports this
 * module so every read registers before it can run. See
 * `../employee-facts.ts` for the shape and the derivation of `payable`.
 */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

// Required employee facts. The compute path reads two `emp[...]` keys,
  // served since 0191 by the profile columns the `jp_hyojun` certificate
  // fields map — kept apart from the 扶養控除等申告書, which carries
  // dependent counts and flags, not the 標準報酬 grade or the kaigo status.
  // The kaigo input stays a checkbox that fails closed toward the
  // employee's side (no cheaper default), never an age-derived display.
  //
  // OPEN, still: which artefact fixes the grade for the operator — the JPS
  // 標準報酬決定通知書 after 定時決定/随時改定, or a grade table the operator
  // reads the monthly remuneration through. This channel carries the value;
  // it does not answer that, and the citation is still owed.
  export const JP_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
    {
      key: "jp_hyojun_hoshu",
      kind: "amount",
      label: "標準報酬月額 (grade value, off the JPS notice)",
      refusalReason:
        "Pension and health price off the 標準報酬 grade, never off raw pay; an undeclared grade "
        + "must not fall through to pricing on the month's wages.",
      required: true,
      producer: { kind: "profile_column", column: "jp_hyojun_hoshu" },
    },
    {
      key: "jp_kaigo_dainigou",
      kind: "flag",
      label: "介護保険第2号被保険者 status",
      refusalReason:
        "A 介護保険第2号被保険者 (40–64) owes the 介護 premium this engine does not price, and an "
        + "undeclared status must not default into health-without-介護 — the cheaper premium.",
      required: true,
      producer: { kind: "profile_column", column: "jp_kaigo_dainigou" },
    },
    {
      key: "jp_employment_insurance_coverage",
      kind: "choice",
      choices: ["insured", "not_insured"],
      label: "雇用保険 coverage status",
      refusalReason:
        "Employment-insurance eligibility determines the employee and employer premiums and the "
        + "月額表 base; an unknown status must not be priced as uncovered.",
      required: true,
      producer: {
        kind: "certificate",
        certificate: "jp_employment_insurance",
        field: "coverage_status",
      },
    },
];

registerEmployeeFacts("JP", JP_EMPLOYEE_FACTS);
