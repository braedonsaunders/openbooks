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
    key: "us_garnishment_minimum_hourly_wage",
    kind: "decimal",
    scale: 2,
    min: "0.01",
    label: "Minimum hourly wage for garnishment protection",
    refusalReason:
      "an ordinary creditor garnishment may not reach disposable earnings below 30 times this hourly wage per week; "
      + "record the federal minimum hourly wage (or a higher state minimum where state garnishment law protects more), "
      + "effective from the date it applies",
    legalBasis:
      "15 U.S.C. §1673(a)(2), measured against the federal minimum hourly wage of 29 U.S.C. §206(a)(1); "
      + "U.S. Department of Labor Fact Sheet #30 (https://www.dol.gov/agencies/whd/fact-sheets/30-cppa).",
    required: false,
  },
  {
    key: "wa_pfml_employer_size",
    kind: "choice",
    label: "Washington PFML employer size",
    choices: [
      { value: "fifty_or_more", label: "50 or more employees" },
      { value: "fewer_than_fifty", label: "Fewer than 50 employees" },
    ],
    refusalReason:
      "employers with 50 or more employees owe the 28.57% employer share of the PFML premium while smaller employers owe no employer share (both still withhold the employee share); record which side this legal employer is on",
    legalBasis:
      "Washington Employment Security Department, Paid Family & Medical Leave premium rate 1.13% for 2026 (released 10/29/25): "
      + "employers with at least 50 employees pay 28.57% of the premium and employees pay 71.43%; smaller employers remit the employee portion only. "
      + "https://esd.wa.gov/about-us/news-release/2025/paid-family-medical-leave-premium-rate-increases-113-2026",
    required: true,
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
