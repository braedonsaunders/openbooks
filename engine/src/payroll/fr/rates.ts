import type { PayrollTaxYearSupport } from "../tax-years.ts";

/**
 * France — statutory-table editions.
 *
 * NOTHING is transcribed yet: the 2026 PAS default grid (grille de taux par
 * défaut, loi de finances pour 2026) and the 2026 URSSAF contribution
 * parameters are both obtainable but neither has been transcribed into this
 * repository, so `editions` is empty and every year is refused by name (see
 * `payrollTaxYearProblem`). The pack stays `installable: false` until a
 * published edition lands here.
 *
 * Sources (not transcriptions):
 * - PAS default grid: loi de finances pour 2026, via impots.gouv.fr
 *   ("Gérer mon prélèvement à la source").
 * - Contribution parameters: URSSAF (urssaf.fr) and the Sécurité sociale
 *   ceiling arrêté (arrêté du 22 décembre 2025, plafond 2026).
 */
export const FR_TAX_YEARS: PayrollTaxYearSupport = {
  country: "FR",
  editions: [],
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/fr/rates.ts",
  scaffold: {
    files: [
      {
        path: "engine/src/payroll/fr/tables-{year}.ts",
        purpose: "Transcribed 2026+ PAS default grid and URSSAF parameters for the year.",
        template: "",
      },
    ],
    barrels: [],
    steps: [
      "Transcribe the PAS grille de taux par défaut from the loi de finances pour {year} (impots.gouv.fr).",
      "Transcribe the year's URSSAF contribution parameters and plafond de la sécurité sociale (urssaf.fr; ceiling arrêté).",
      "Add the edition to FR_TAX_YEARS with status \"published\" and the agency citation.",
      "Add a golden stub test proving the transcribed figures calculate.",
    ],
  },
};
