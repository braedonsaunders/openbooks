/**
 * US required employee facts: the `emp` keys the pack's statutory engine
 * reads, DECLARED with kind, bounds, producer and refusal reason.
 *
 * One source, two readers: `./pack.ts` states it as the pack's
 * `employeeFacts` declaration, and `./compute-statutory.ts` imports this
 * module so every read registers before it can run. See
 * `../employee-facts.ts` for the shape and the derivation of `payable`.
 */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

// Required employee facts. The compute path reads twelve `emp` keys and
  // every one resolves in a typed declaration — nine W-4 answers through
  // their profile-column mappings (us/jurisdictions.ts), FICA/FUTA
  // exemption through the profileExemptionFlags below, and residence_region
  // through the schema-owned base profile column. None blocks: absent
  // answers fall back to the statutory defaults (single, zero, work
  // region), so all twelve are required: false and the pack is payable.
  export const US_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
    {
      key: "filing_status", kind: "choice", choices: ["single", "married_joint", "head_household"],
      label: "Step 1(c) — Filing status",
      refusalReason: "No refusal: with no W-4 on file the employee is withheld as single.",
      required: false,
      producer: { kind: "profile_column", column: "filing_status" },
    },
    {
      key: "multiple_jobs", kind: "flag",
      label: "Step 2 — Multiple jobs or spouse works",
      refusalReason: "No refusal: absent means the Step 2 Checkbox schedule does not apply.",
      required: false,
      producer: { kind: "profile_column", column: "multiple_jobs" },
    },
    {
      key: "dependent_credits", kind: "amount",
      label: "Step 3 — Dependents and other credits",
      refusalReason: "No refusal: absent means no Step 3 credits.",
      required: false,
      producer: { kind: "profile_column", column: "dependent_credits" },
    },
    {
      key: "other_income_annual", kind: "amount",
      label: "Step 4(a) — Other income",
      refusalReason: "No refusal: absent means no untaxed other income.",
      required: false,
      producer: { kind: "profile_column", column: "other_income_annual" },
    },
    {
      key: "deductions_annual", kind: "amount",
      label: "Step 4(b) — Deductions",
      refusalReason: "No refusal: absent means the standard deduction only.",
      required: false,
      producer: { kind: "profile_column", column: "deductions_annual" },
    },
    {
      key: "additional_tax_per_period", kind: "amount",
      label: "Step 4(c) — Extra withholding",
      refusalReason: "No refusal: absent means no extra withholding.",
      required: false,
      producer: { kind: "profile_column", column: "additional_tax_per_period" },
    },
    {
      key: "tax_exempt", kind: "flag",
      label: "Exempt from federal withholding",
      refusalReason: "No refusal: absent means federal income tax is withheld normally.",
      required: false,
      producer: { kind: "profile_column", column: "tax_exempt" },
    },
    {
      key: "w4_pre_2020", kind: "flag",
      label: "2019-or-earlier W-4 on file",
      refusalReason: "No refusal: absent means the redesigned W-4 steps apply.",
      required: false,
      producer: { kind: "profile_column", column: "w4_pre_2020" },
    },
    {
      key: "w4_allowances", kind: "count", min: 0, max: 99,
      label: "Withholding allowances (2019-or-earlier W-4)",
      refusalReason: "No refusal: read only when the pre-2020 box is set, otherwise zero.",
      required: false,
      producer: { kind: "profile_column", column: "w4_allowances" },
    },
    {
      key: "fica_exempt", kind: "flag",
      label: "FICA exempt",
      refusalReason: "No refusal: absent means Social Security and Medicare are withheld normally.",
      required: false,
      producer: { kind: "exemption_flag", column: "fica_exempt" },
    },
    {
      key: "futa_exempt", kind: "flag",
      label: "FUTA/SUI exempt",
      refusalReason: "No refusal: absent means unemployment tax is computed normally.",
      required: false,
      producer: { kind: "exemption_flag", column: "futa_exempt" },
    },
    {
      key: "residence_region", kind: "code",
      label: "State of residence (when it differs from the work state)",
      refusalReason:
        "No refusal: null means not recorded and resolves to the work region, reported as an assumption.",
      required: false,
      producer: { kind: "base_column", column: "residence_region" },
    },
];

registerEmployeeFacts("US", US_EMPLOYEE_FACTS);
