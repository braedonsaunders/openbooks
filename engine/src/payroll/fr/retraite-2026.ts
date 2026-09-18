import { PayrollPackError } from "../payroll-error.ts";

/**
 * Transcribed AGIRC-ARRCO tables for calendar year 2026.
 *
 * Provenance (read the local copies — this vantage cannot reach the host):
 * - `https://www.agirc-arrco.fr/entreprises/mon-entreprise/calculer-et-declarer/
 *   le-calcul-des-cotisations-de-retraite-complementaire/`, verified
 *   HTTP 200 from the host network, server-rendered (found through the
 *   site's own sitemap: sitemap.xml -> page-sitemap1.xml). Saved as
 *   `packs/sources/agirc-arrco-calcul.html / .txt`.
 * - No vendor, law-firm, OECD or other-ERP source is used anywhere.
 *
 * Operative text is quoted on every constant below. Non-breaking spaces
 * and HTML entities normalised.
 *
 * Money discipline: rates are exact decimal FRACTION strings, never
 * floats. The engine splits the quoted appelé totals 60/40 itself (the
 * page's split columns are centime displays of that exact split) and
 * consumes everything with bigint units (see ./cotisations.ts).
 */

/**
 * Tranche assiettes 2026:
 *
 * "Tranches Agirc-Arrco de l'assiette de cotisation en 2026 Tranche 1
 * Tranche 2 Limites jusqu'à 1 fois le plafond de la Sécurité sociale
 * Entre 1 et 8 fois le plafond de la Sécurité sociale Mensuel en €
 * entre 0 et 4 005 € entre 4 005 et 32 040 € Annuel en € entre 0 et
 * 48 060 € entre 48 060 € et 384 480 €"
 *
 * Consistency check against the URSSAF tables (./cotisations-2026.ts):
 * the T1 top is the monthly PASS (4 005 €), the T2 top is 8 × 4 005 =
 * 32 040 €, the annual figures are 48 060 € and 8 × 48 060 = 384 480 €.
 */
export const FR_ARRCO_TRANCHES_2026 = {
  t1TopMonthly: "4005",
  t2TopMonthly: "32040",
  t1TopAnnual: "48060",
  t2TopAnnual: "384480",
  quote:
    "Tranches Agirc-Arrco de l'assiette de cotisation en 2026 Tranche 1 "
    + "Tranche 2 Limites jusqu'à 1 fois le plafond de la Sécurité sociale "
    + "Entre 1 et 8 fois le plafond de la Sécurité sociale Mensuel en € "
    + "entre 0 et 4 005 € entre 4 005 et 32 040 € Annuel en € entre 0 et "
    + "48 060 € entre 48 060 € et 384 480 €",
} as const;

/**
 * Taux appelés 2026:
 *
 * "Taux de cotisation Agirc-Arrco appelés en 2026 2026 Taux T1 7,87%
 * T2 21,59%"
 *
 * The appelé rate is the contractuel rate × 127 %: "Le taux de
 * cotisation appelé, ou taux effectif, correspond au taux contractuel
 * de cotisation, ou taux de calcul des points, multiplié par un
 * pourcentage d'appel de 127 %." The engine prices the appelé totals
 * below — the 127 % factor is quoted for provenance, never applied.
 */
export const FR_ARRCO_TAUX_2026 = {
  t1: { rate: "0.0787", quote: "Taux de cotisation Agirc-Arrco appelés en 2026 2026 Taux T1 7,87%" },
  t2: { rate: "0.2159", quote: "Taux de cotisation Agirc-Arrco appelés en 2026 2026 Taux T2 21,59%" },
  appelPct: "127",
  appelQuote:
    "Le taux de cotisation appelé, ou taux effectif, correspond au taux "
    + "contractuel de cotisation, ou taux de calcul des points, multiplié "
    + "par un pourcentage d'appel de 127 %",
} as const;

/**
 * Regulated 60/40 split:
 *
 * "Répartition des cotisations La répartition des cotisations
 * Agirc-Arrco entre l'employeur et le salarié est réglementée. Les
 * cotisations sont prises en charge à hauteur de 60 % par l'employeur
 * et à hauteur de 40 % pour [le salarié]"
 *
 * The engine splits every quoted total itself (employer 60 %, salarié
 * 40 %). The page's split columns corroborate rather than drive:
 * 7,87 % × 40 % = 3,148 % (page shows 3,15 %), × 60 % = 4,722 %
 * (4,72 %); 21,59 % × 40 % = 8,636 % (8,64 %), × 60 % = 12,954 %
 * (12,95 %). Headers: "Taux de cotisation Agirc-Arrco Part salariale
 * Part patronale Total / Taux de calcul des points".
 */
export const FR_ARRCO_SPLIT_QUOTE_2026 =
  "Répartition des cotisations La répartition des cotisations "
  + "Agirc-Arrco entre l'employeur et le salarié est réglementée. Les "
  + "cotisations sont prises en charge à hauteur de 60 % par l'employeur "
  + "et à hauteur de 40 % pour le salarié sur les tranches 1 et 2. "
  + "Néanmoins, un accord collectif a pu modifier cette répartition";

/**
 * Contribution d'équilibre général (CEG) — created with the CET when
 * "Les cotisations AGFF, CET (Contribution d'équilibre temporaire) et
 * GMP ont disparu au 31 décembre 2018":
 *
 * "Une contribution d'équilibre général (CEG) ainsi qu'une contribution
 * d'équilibre temporaire ont été créées. Elle permet de compenser les
 * charges résultant des départs à la retraite avant 67 ans."
 *
 * Headers "Taux de cotisation Agirc-Arrco Part salariale Part patronale
 * Total": "Tranche 1 (salaire jusqu'au plafond de la Sécurité sociale)
 * CEG 0,86% 1,29% 2,15 %" and "Tranche 2 (salaire compris entre 1 et 8
 * fois le plafond de la Sécurité sociale) CEG 1,08% 1,62% 2,70%".
 * The totals corroborate the 60/40 split exactly (2,15 × 40 % = 0,86;
 * 2,70 × 60 % = 1,62), so the engine splits the quoted totals.
 */
export const FR_CEG_2026 = {
  t1: {
    rate: "0.0215",
    quote:
      "Tranche 1 (salaire jusqu'au plafond de la Sécurité sociale) "
      + "CEG 0,86% 1,29% 2,15 %",
  },
  t2: {
    rate: "0.027",
    quote:
      "Tranche 2 (salaire compris entre 1 et 8 fois le plafond de la "
      + "Sécurité sociale) CEG 1,08% 1,62% 2,70%",
  },
} as const;

/**
 * Contribution d'équilibre technique (CET):
 *
 * "La CET (Contribution d'équilibre technique) s'applique à tous les
 * salariés dont le salaire est supérieur au plafond de la Sécurité
 * sociale. Pour ces personnes, la CET est prélevée sur les tranches 1
 * et 2 au taux de 0,35 %."
 *
 * Headers "CET Assiette Tranche 1 + Tranche 2 Part salariale Part
 * patronale Total": "0,14% 0,21% 0,35%". Strictly above the plafond —
 * the engine applies no CET at exactly the plafond. Split 60/40 in the
 * engine from the quoted 0,35 % total (0,35 × 40 % = 0,14 exactly).
 */
export const FR_CET_2026 = {
  rate: "0.0035",
  quote:
    "La CET (Contribution d'équilibre technique) s'applique à tous les "
    + "salariés dont le salaire est supérieur au plafond de la Sécurité "
    + "sociale. Pour ces personnes, la CET est prélevée sur les tranches "
    + "1 et 2 au taux de 0,35 %",
  splitQuote: "CET Assiette Tranche 1 + Tranche 2 Part salariale Part patronale Total 0,14% 0,21% 0,35%",
} as const;

/**
 * APEC (cadres only) — transcribed and NOT applied:
 *
 * "APEC (pour les salariés cadres) Assiette Tranche 1 + Tranche 2
 * limitée à 4 fois le plafond de la sécurité sociale Part salariale
 * Part patronale Total 0,024% 0,036% 0,06%"
 *
 * No pack channel carries the employee's cadre status, so the engine
 * refuses APEC by name (see FR_COTISATION_REFUSALS_2026) instead of
 * charging every salary 0,06 % or silently dropping it for cadres.
 */
export const FR_APEC_2026 = {
  rate: "0.0006",
  quote:
    "APEC (pour les salariés cadres) Assiette Tranche 1 + Tranche 2 "
    + "limitée à 4 fois le plafond de la sécurité sociale Part salariale "
    + "Part patronale Total 0,024% 0,036% 0,06%",
} as const;

/** 2026 AGIRC-ARRCO tables resolve by calendar year and throw otherwise. */
export function frRetraiteYearForPayDate(payDate: string): 2026 {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    throw new PayrollPackError(
      `FR retraite complémentaire needs an ISO pay date (YYYY-MM-DD), got "${payDate}"`,
    );
  }
  if (payDate < "2026-01-01" || payDate > "2026-12-31") {
    throw new PayrollPackError(
      `FR retraite complémentaire has no transcribed tables for pay date ${payDate}: `
      + "the FR pack transcribes calendar 2026 only "
      + "(AGIRC-ARRCO calcul des cotisations 2026). "
      + "Transcribe the year's tables into engine/src/payroll/fr/ first.",
    );
  }
  return 2026;
}
