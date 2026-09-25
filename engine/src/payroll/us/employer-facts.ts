import type { PayrollEmployerFact } from "../employer-facts.ts";

export const US_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
  {
    key: "ut_withholding_commission_waiver",
    kind: "choice",
    label: "Utah Tax Commission-approved employer withholding waiver",
    choices: [
      { value: "approved", label: "Approved" },
      { value: "not_approved", label: "Not approved / revoked" },
    ],
    effectiveThroughRequiredFor: ["approved"],
    refusalReason: "only use an advance Commission approval for an employer doing business in Utah for 60 days or less without a withholding account; enter the exact approved span",
    legalBasis: "Utah State Tax Commission, Publication 14 (Rev. 4/26), pp. 2–3; Utah Code §59-10-402(2). https://tax.utah.gov/forms-pubs/pub-14/",
    required: false,
  },
];
