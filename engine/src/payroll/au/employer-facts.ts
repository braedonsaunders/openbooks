import type { PayrollEmployerFact } from "../employer-facts.ts";

/**
 * Facts the AU pack requires of the legal employer.
 *
 * State and territory payroll tax is assessed on the employer's Australian
 * GROUP wages above each jurisdiction's annual threshold, with grouping,
 * nexus and exemption rules no per-stub engine can observe. The pack
 * transcribes no state payroll tax computation at all, so a run with
 * covered wages and no established position would silently omit a
 * possibly-owed levy. The position fact closes that: below-threshold
 * ungrouped employers attest it and price normally; registered (or
 * liable) employers refuse by name until the computation exists.
 */
export const AU_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
  {
    key: "payroll_tax_position",
    kind: "choice",
    label: "State payroll tax position",
    refusalReason:
      "state and territory payroll tax is assessed on the employer's Australian group wages "
      + "above each jurisdiction's annual threshold, and the pack cannot tell a below-threshold "
      + "ungrouped employer from a liable one",
    legalBasis:
      "State and territory payroll tax acts (Payroll Tax Act 2007 (NSW) and equivalents); "
      + "thresholds and rates published per jurisdiction (e.g. Revenue NSW thresholds and rates)",
    required: true,
    effectivePeriod: "date",
    choices: [
      { value: "below_threshold_ungrouped", label: "Below every threshold, ungrouped" },
      { value: "registered_liable", label: "Registered for state payroll tax (or liable)" },
    ],
  },
];
