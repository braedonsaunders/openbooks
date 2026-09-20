/**
 * CA required employee facts: the `emp` keys the pack's statutory engine
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
  // every one resolves in a typed declaration — the TD1/TD1XX answers
  // through their profile-column mappings (canada/jurisdictions.ts). None
  // blocks: an employee who files nothing is withheld at claim code 1
  // with no extras, so all twelve are required: false and the pack is
  // payable.
  export const CA_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
    {
      key: "additional_tax_per_period", kind: "amount",
      label: "Additional tax to be deducted (per pay period)",
      refusalReason: "No refusal: absent means no extra tax requested (T4127 factor L).",
      required: false,
      producer: { kind: "profile_column", column: "additional_tax_per_period" },
    },
    {
      key: "authorized_annual_deductions", kind: "amount",
      label: "Deductions authorized by a tax services office",
      refusalReason: "No refusal: absent means no authorized deductions (T4127 factor F2).",
      required: false,
      producer: { kind: "profile_column", column: "authorized_annual_deductions" },
    },
    {
      key: "authorized_federal_credits", kind: "amount",
      label: "Federal tax credits authorized in a letter",
      refusalReason: "No refusal: absent means no authorized federal credits (T4127 factor K3).",
      required: false,
      producer: { kind: "profile_column", column: "authorized_federal_credits" },
    },
    {
      key: "authorized_provincial_credits", kind: "amount",
      label: "Provincial tax credits authorized in a letter",
      refusalReason: "No refusal: absent means no authorized provincial credits.",
      required: false,
      producer: { kind: "profile_column", column: "authorized_provincial_credits" },
    },
    {
      key: "cpp_exempt", kind: "flag",
      label: "Exempt from CPP/QPP contributions",
      refusalReason: "No refusal: absent means CPP/QPP is withheld normally.",
      required: false,
      producer: { kind: "profile_column", column: "cpp_exempt" },
    },
    {
      key: "ei_exempt", kind: "flag",
      label: "Exempt from EI premiums",
      refusalReason: "No refusal: absent means EI is withheld normally.",
      required: false,
      producer: { kind: "profile_column", column: "ei_exempt" },
    },
    {
      key: "federal_claim_amount", kind: "amount",
      label: "Total claim amount — exact dollars",
      refusalReason: "No refusal: absent means the claim code band applies (T4127 factor TC).",
      required: false,
      producer: { kind: "profile_column", column: "federal_claim_amount" },
    },
    {
      key: "federal_claim_code", kind: "count", min: 0, max: 10,
      label: "Total claim amount — claim code",
      refusalReason: "No refusal: an employee who files nothing is withheld at code 1.",
      required: false,
      producer: { kind: "profile_column", column: "federal_claim_code" },
    },
    {
      key: "prescribed_zone_deduction", kind: "amount",
      label: "Prescribed zone deduction (annual)",
      refusalReason: "No refusal: absent means no zone deduction (T4127 factor HD).",
      required: false,
      producer: { kind: "profile_column", column: "prescribed_zone_deduction" },
    },
    {
      key: "provincial_claim_amount", kind: "amount",
      label: "Provincial claim amount — exact dollars",
      refusalReason: "No refusal: absent means the provincial claim code band applies.",
      required: false,
      producer: { kind: "profile_column", column: "provincial_claim_amount" },
    },
    {
      key: "provincial_claim_code", kind: "count", min: 0, max: 10,
      label: "Provincial claim amount — claim code",
      refusalReason: "No refusal: an employee who files nothing is withheld at the basic claim.",
      required: false,
      producer: { kind: "profile_column", column: "provincial_claim_code" },
    },
    {
      key: "tax_exempt", kind: "flag",
      label: "No income tax is to be withheld",
      refusalReason: "No refusal: absent means income tax is withheld normally.",
      required: false,
      producer: { kind: "profile_column", column: "tax_exempt" },
    },
];

registerEmployeeFacts("CA", CA_EMPLOYEE_FACTS);
