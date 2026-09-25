import type { PayrollEmployerFact } from "../employer-facts.ts";

export const FR_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
  {
    key: "fr_apprentissage_regime",
    kind: "choice",
    label: "Régime de taxe d'apprentissage de l'établissement",
    choices: [
      { value: "droit_commun", label: "Droit commun (0,68 %)" },
      { value: "alsace_moselle", label: "Alsace-Moselle, Bas-Rhin / Haut-Rhin / Moselle (0,44 %)" },
    ],
    refusalReason:
      "the taxe d'apprentissage is 0,68 % mainland France but 0,44 % in Bas-Rhin, Haut-Rhin and Moselle — the establishment's regime decides which rate prices",
    legalBasis: "URSSAF, taxe d'apprentissage (0,68 %; 0,44 % Bas-Rhin, Haut-Rhin, Moselle)",
    required: true,
    effectivePeriod: "date",
  },
  {
    key: "fr_ags_employer_type",
    kind: "choice",
    label: "Type d'employeur pour la cotisation AGS",
    choices: [
      { value: "ordinary", label: "Employeur ordinaire (0,25 %)" },
      { value: "temporary_work_agency", label: "Entreprise de travail temporaire (0,03 %)" },
    ],
    refusalReason:
      "URSSAF publishes 0.25% generally and 0.03% for temporary-work agencies; the legal employer's effective classification determines the AGS rate",
    legalBasis: "URSSAF, taux des cotisations du secteur privé (AGS; CTP 496)",
    required: true,
    effectivePeriod: "date",
  },
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
