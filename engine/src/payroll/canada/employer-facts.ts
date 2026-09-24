import type { PayrollEmployerFact } from "../employer-facts.ts";

export const CA_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
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
