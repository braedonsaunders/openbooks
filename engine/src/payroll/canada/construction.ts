import type { PayrollPackConstruction } from "../labor-compliance.ts";

/**
 * Canada construction carve-outs (HR-13): pack data, not generic branches.
 *
 * Every fact here is a TRANSCRIPTION of a statute, cited on the rule it
 * belongs to — the employment-standards.ts doctrine. Nothing here is a
 * policy choice, a default, or a convenience. Figures are STANDING LAW
 * with no tax-year dimension; a future change is a NEW effective-dated
 * entry, never an edit in place. Concepts the pack has not transcribed
 * (road-building overtime thresholds, termination-notice exemptions,
 * holiday-pay-in-lieu percentages) are OMITTED, not guessed — downstream
 * readers refuse untranscribed concepts by name rather than inheriting a
 * neighbour's formula.
 *
 * Types only from ../labor-compliance.ts (erased at runtime, no cycle).
 */
export const CA_CONSTRUCTION: PayrollPackConstruction = {
  rules: [
    {
      kind: "vacation_pay_in_lieu",
      region: "ON",
      percent: "4",
      citation:
        "Employment Standards Act, 2000, SO 2000, c 41, s. 33 — vacation pay for construction employees",
      effectiveFrom: "2026-01-01",
    },
    {
      kind: "remittance_component",
      componentKey: "ccq_vacation_indemnity",
      purpose: "Vacation and statutory-holiday indemnity remitted to the CCQ for Quebec construction employees",
      citation:
        "Act respecting labour relations, vocational training and workforce management in the construction industry, CQLR c R-20",
      effectiveFrom: "2026-01-01",
    },
    {
      kind: "remittance_component",
      componentKey: "ccq_pension",
      purpose: "Pension contributions remitted to the CCQ for Quebec construction employees",
      citation:
        "Act respecting labour relations, vocational training and workforce management in the construction industry, CQLR c R-20",
      effectiveFrom: "2026-01-01",
    },
    {
      kind: "premium_class",
      region: "ON",
      classCode: "construction",
      className: "Construction premium class",
      ratePer100: null,
      citation:
        "Workplace Safety and Insurance Act, 1997, SO 1997, c 16, Sch A — class rates are published annually by the WSIB and are not transcribed here",
      effectiveFrom: "2026-01-01",
    },
    {
      kind: "interruption_insurable_hours",
      includes: ["paid_vacation", "stat_holiday", "sick"],
      citation:
        "Employment Insurance Act, SC 1996, c 23; Employment Insurance Regulations, SOR/96-332 — insurable-hours rule for the employment interruption record",
      effectiveFrom: "2026-01-01",
    },
  ],
};
