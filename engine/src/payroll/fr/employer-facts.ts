import type { PayrollEmployerFact } from "../employer-facts.ts";

export const FR_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
  {
    key: "effectif_moyen_annuel",
    kind: "decimal",
    scale: 2,
    min: "0",
    label: "Effectif salarié annuel de l'employeur",
    refusalReason:
      "the RGDU FNAL/T coefficient branch requires the prior-calendar-year average for this legal employer, including its establishments",
    legalBasis: "Code de la sécurité sociale, articles L.130-1 and R.130-1",
    required: true,
    effectivePeriod: "calendar_year",
  },
];
