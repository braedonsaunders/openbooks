import type { PayrollEmployerFact } from "../employer-facts.ts";

export const ES_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
  {
    key: "es_atep_rate",
    kind: "decimal",
    scale: 4,
    min: "0",
    max: "1",
    label: "Tarifa de primas AT/EP del establecimiento",
    refusalReason:
      "Orden PJC/297/2026 art. 4.b prices AT/EP exclusively on the employer from the activity tariff "
      + "(DA 61ª LGSS as amended); without the establishment's filed tariff the employer premium cannot be calculated",
    legalBasis: "Orden PJC/297/2026, art. 4.b; LGSS DA 61ª (tarifa de primas)",
    required: true,
    effectivePeriod: "calendar_year",
  },
];
