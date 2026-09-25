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
  {
    key: "sui_financing_method",
    kind: "choice",
    scope: "filing_account",
    filingProgramType: "us_state_sui",
    label: "State unemployment financing method",
    choices: [
      { value: "contributory", label: "Contributory / tax-rated" },
      { value: "reimbursable", label: "Reimbursable" },
      { value: "school_employees_fund", label: "California School Employees Fund" },
    ],
    refusalReason:
      "the state-assigned financing method determines whether a contribution rate or actual benefit reimbursements apply; record it for this state unemployment account",
    legalBasis:
      "State unemployment account determination; California EDD distinguishes tax-rated from reimbursable employers and identifies the School Employees Fund as a separate financing method (https://edd.ca.gov/tax-rated-employers; https://edd.ca.gov/en/payroll_taxes/reimbursable_method_of_paying_ui_benefits/; https://edd.ca.gov/en/payroll_taxes/school_employees_fund/).",
    required: true,
  },
];
