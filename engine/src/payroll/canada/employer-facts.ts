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
    key: "qc_wsdrf_training_expenditures",
    kind: "decimal",
    scale: 2,
    min: "0",
    label: "WSDRF eligible training expenditures for the year",
    refusalReason:
      "an employer with $2M or more of Québec payroll owes 1% of payroll less its eligible training "
      + "expenditures, so the shortfall cannot be determined without them",
    legalBasis:
      "Revenu Québec, Contribution to the Workforce Skills Development and Recognition Fund (WSDRF); "
      + "Act to promote workforce skills development and recognition",
    required: false,
    effectivePeriod: "calendar_year",
  },
  {
    key: "qc_wsdrf_quality_certificate",
    kind: "boolean",
    label: "WSDRF holds a valid quality certificate (certificat de qualité)",
    refusalReason:
      "a valid quality certificate exempts the employer from the WSDRF contribution, so the summary "
      + "cannot state the exemption without it",
    legalBasis:
      "Revenu Québec, Contribution to the Workforce Skills Development and Recognition Fund (WSDRF)",
    required: false,
    effectivePeriod: "calendar_year",
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
  {
    key: "ns_remembrance_business_class",
    kind: "choice",
    label: "Nova Scotia Remembrance Day business class",
    refusalReason:
      "An employee who worked November 11 cannot be granted or denied the statutory alternate paid day without it.",
    legalBasis:
      "Remembrance Day Act (Nova Scotia), RSNS 1989 c 396 — alternate day off with pay; "
      + "exempt: farming, fishing, aquaculture, Christmas tree operations, forestry, industrial undertakings.",
    // Only genuinely needed when an employee actually worked November 11:
    // an unrecorded value refuses by name in the grant, naming the Setup
    // page, rather than stopping every Canadian run.
    required: false,
    effectivePeriod: "date",
    choices: [
      { value: "general", label: "General business (covered by the Act)" },
      { value: "farming", label: "Farming" },
      { value: "fishing", label: "Fishing" },
      { value: "aquaculture", label: "Aquaculture" },
      { value: "christmas_tree", label: "Christmas tree operations" },
      { value: "forestry", label: "Forestry (Labour Standards Code meaning)" },
      { value: "industrial_undertaking", label: "Industrial undertaking (Labour Standards Code meaning)" },
    ],
  },
];

/** Business classes the Remembrance Day Act exempts from the alternate day. */
export const NS_REMEMBRANCE_EXEMPT_BUSINESS_CLASSES: readonly string[] = [
  "farming",
  "fishing",
  "aquaculture",
  "christmas_tree",
  "forestry",
  "industrial_undertaking",
];
