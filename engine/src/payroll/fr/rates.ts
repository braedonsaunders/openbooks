import type { PayrollTaxYearSupport } from "../tax-years.ts";

/**
 * France — statutory-table editions.
 *
 * Calendar 2026 is transcribed (PAS grille I, métropole, plus the PASS),
 * as TWO editions: DGFiP replaced the grids mid-year, so January–April
 * versements use the May-2025 grids and May–December versements the
 * May-2026 grids (see ./tables-2026.ts). The 2026 URSSAF contribution
 * rates are transcribed in ./cotisations-2026.ts from the browser-rendered
 * URSSAF taux-secteur-privé and plafonds pages (both verified 200; the
 * server HTML is a JS shell — "reachable, JS-rendered", not "connection
 * reset"). PAS, the URSSAF cotisations and AGIRC-ARRCO (T1/T2, CEG,
 * CET) compute; the pack flips `installable: true` in the commit where
 * the parity harness lands. Tenant-declared AT/MP / versement mobilité
 * rates have no engine channel and APEC is refused by name — narrow,
 * named, and stated.
 */
export const FR_TAX_YEARS: PayrollTaxYearSupport = {
  country: "FR",
  editions: [
    {
      year: 2026,
      label: "BOI-BAREME-000037-20250410 (grilles à compter du 1er mai 2025)",
      effectiveFrom: "2026-01-01",
      citation:
        "DGFiP, BOI-BAREME-000037-20250410 (bofip.impots.gouv.fr), "
        + "grille I métropole; PASS via service-public.gouv.fr A15386 "
        + "(arrêté du 22 décembre 2025)",
      status: "published",
    },
    {
      year: 2026,
      label: "BOI-BAREME-000037-20260407 (grilles à compter du 1er mai 2026)",
      effectiveFrom: "2026-05-01",
      citation:
        "DGFiP, BOI-BAREME-000037-20260407 (bofip.impots.gouv.fr; figures "
        + "unchanged in -20260706), grille I métropole",
      status: "published",
    },
  ],
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
