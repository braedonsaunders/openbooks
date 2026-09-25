import type { PayrollEmployerFact } from "../employer-facts.ts";

export const GB_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
  {
    key: "gb_apprenticeship_levy_allowance",
    kind: "decimal",
    scale: 2,
    min: "0",
    max: "15000",
    label: "Apprenticeship Levy annual allowance share",
    refusalReason:
      "connected employers share one £15,000 annual allowance — without this legal employer's "
      + "allocated share the monthly levy cannot price. A standalone employer records 15000.00.",
    legalBasis:
      "HMRC Pay Apprenticeship Levy "
      + "(https://www.gov.uk/guidance/pay-apprenticeship-levy): 0.5% above a £3 million "
      + "annual pay bill, connected employers counted together with one shared allowance; "
      + "allowance allocation Apprenticeship Levy Manual ALM06000 "
      + "(https://www.gov.uk/hmrc-internal-manuals/apprenticeship-levy/alm06000)",
    required: false,
    effectivePeriod: "date",
  },
];
