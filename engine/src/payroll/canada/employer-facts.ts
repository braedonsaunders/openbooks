import type { PayrollEmployerFact } from "../employer-facts.ts";

export const CA_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
  {
    key: "cnt_exemption",
    kind: "choice",
    label: "Québec CNT contribution exemption class",
    refusalReason:
      "the 0.06% contribution related to labour standards applies to every Québec employer except the statutory exemption classes — an unclassified employer cannot price it",
    legalBasis:
      "LE-39.0.2-V Calculation of the Contribution Related to Labour Standards; Revenu Québec, Contribution Related to Labour Standards (exempt employers)",
    required: true,
    effectivePeriod: "date",
    choices: [
      { value: "none", label: "None of the below — subject to the contribution" },
      { value: "religious_institution", label: "Religious institution" },
      { value: "daycare_centre", label: "Daycare centre (garderie)" },
      { value: "parity_committee", label: "Parity committee (decree committee)" },
      { value: "fabrique_or_church_trustees", label: "Fabrique / corporation of trustees for churches" },
      { value: "charity_assisting_needy", label: "Charity assisting persons in need directly and free of charge" },
      { value: "canada_labour_code_business", label: "Business under the Canada Labour Code (bank, airport, radio, federal undertaking)" },
      { value: "international_organization", label: "International organization with a Québec establishment" },
    ],
  },
  {
    key: "work_week_start",
    kind: "choice",
    label: "Employer work-week start day",
    refusalReason: "the Ontario and Quebec statutory holiday lookback ends at the end of the employer's selected work week",
    legalBasis: "Employment Standards Act, 2000 (Ontario), s. 1; Act respecting labour standards (Quebec), s. 1(12)",
    required: false,
    effectivePeriod: "date",
    choices: [
      { value: "0", label: "Sunday" },
      { value: "1", label: "Monday" },
      { value: "2", label: "Tuesday" },
      { value: "3", label: "Wednesday" },
      { value: "4", label: "Thursday" },
      { value: "5", label: "Friday" },
      { value: "6", label: "Saturday" },
    ],
  },
];
