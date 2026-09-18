import { toUnits } from "../../money.ts";
import { PayrollPackError } from "../payroll-error.ts";

/**
 * Transcribed DGFiP tables for calendar year 2026.
 *
 * Host vantage (recorded distinctly, per sourcing rules):
 * - bofip.impots.gouv.fr: HTTP 200 — every figure below comes from here.
 * - service-public.gouv.fr: HTTP 200 — the plafond figures.
 * - legifrance.gouv.fr: HTTP 403 Forbidden (edge deny, not JS SPA).
 * - economie.gouv.fr: HTTP 403. urssaf.fr: connection reset (000).
 *   boss.gouv.fr: connect timeout. Nothing from those hosts is transcribed
 *   or cited.
 * - No vendor, law-firm, OECD or other-ERP source is used anywhere.
 *
 * Money discipline: figures are decimal STRINGS, never floats. Bands are
 * whole euros; rates are exact decimals (0,5 % is "0.005"). The engine
 * consumes them with bigint units (see ./compute-statutory.ts).
 */

/** One default-rate band: [from, upTo) at `rate`. `upTo: null` is open. */
export interface FrPasBand {
  readonly from: string;
  readonly upTo: string | null;
  readonly rate: string;
}

/**
 * Grille I (métropole ou hors de France) applicable aux versements de
 * janvier à avril 2026 — BOI-BAREME-000037-20250410 (version en vigueur du
 * 10/04/2025 au 07/04/2026) :
 *
 * "Grille des taux par défaut applicables aux contribuables domiciliés en
 * métropole et hors de France à compter du 1er mai 2025"
 *
 * Quoted rows: "Inférieure à 1 620 euros 0 %" … "Supérieure ou égale à
 * 1 911 euros et inférieure à 2 042 euros 2,9 %" … "Supérieure ou égale à
 * 55 062 euros 43 %".
 */
export const FR_PAS_METROPOLE_MAY2025: readonly FrPasBand[] = [
  { from: "0", upTo: "1620", rate: "0" },
  { from: "1620", upTo: "1683", rate: "0.005" },
  { from: "1683", upTo: "1791", rate: "0.013" },
  { from: "1791", upTo: "1911", rate: "0.021" },
  { from: "1911", upTo: "2042", rate: "0.029" },
  { from: "2042", upTo: "2151", rate: "0.035" },
  { from: "2151", upTo: "2294", rate: "0.041" },
  { from: "2294", upTo: "2714", rate: "0.053" },
  { from: "2714", upTo: "3107", rate: "0.075" },
  { from: "3107", upTo: "3539", rate: "0.099" },
  { from: "3539", upTo: "3983", rate: "0.119" },
  { from: "3983", upTo: "4648", rate: "0.138" },
  { from: "4648", upTo: "5574", rate: "0.158" },
  { from: "5574", upTo: "6974", rate: "0.179" },
  { from: "6974", upTo: "8711", rate: "0.20" },
  { from: "8711", upTo: "12091", rate: "0.24" },
  { from: "12091", upTo: "16376", rate: "0.28" },
  { from: "16376", upTo: "25706", rate: "0.33" },
  { from: "25706", upTo: "55062", rate: "0.38" },
  { from: "55062", upTo: null, rate: "0.43" },
];

/**
 * Grille I (métropole ou hors de France) applicable aux versements à compter
 * de mai 2026 — BOI-BAREME-000037-20260407 (en vigueur 07/04/2026 au
 * 06/07/2026), figures unchanged in BOI-BAREME-000037-20260706 (en vigueur
 * du 06/07/2026 à aujourd'hui, which only moved §IV, the contrats-courts
 * abattement):
 *
 * "Grille des taux par défaut applicables aux contribuables domiciliés en
 * métropole et hors de France à compter du 1er mai 2026"
 *
 * Quoted rows: "Inférieure à 1 635 euros 0 %" … "Supérieure ou égale à
 * 2 060 euros et inférieure à 2 170 euros 3,5 %" … "Supérieure ou égale à
 * 2 738 euros et inférieure à 3 135 euros 7,5 %" … "Supérieure ou égale à
 * 55 558 euros 43 %".
 */
export const FR_PAS_METROPOLE_MAY2026: readonly FrPasBand[] = [
  { from: "0", upTo: "1635", rate: "0" },
  { from: "1635", upTo: "1698", rate: "0.005" },
  { from: "1698", upTo: "1807", rate: "0.013" },
  { from: "1807", upTo: "1928", rate: "0.021" },
  { from: "1928", upTo: "2060", rate: "0.029" },
  { from: "2060", upTo: "2170", rate: "0.035" },
  { from: "2170", upTo: "2315", rate: "0.041" },
  { from: "2315", upTo: "2738", rate: "0.053" },
  { from: "2738", upTo: "3135", rate: "0.075" },
  { from: "3135", upTo: "3571", rate: "0.099" },
  { from: "3571", upTo: "4019", rate: "0.119" },
  { from: "4019", upTo: "4690", rate: "0.138" },
  { from: "4690", upTo: "5624", rate: "0.158" },
  { from: "5624", upTo: "7037", rate: "0.179" },
  { from: "7037", upTo: "8789", rate: "0.20" },
  { from: "8789", upTo: "12200", rate: "0.24" },
  { from: "12200", upTo: "16523", rate: "0.28" },
  { from: "16523", upTo: "25937", rate: "0.33" },
  { from: "25937", upTo: "55558", rate: "0.38" },
  { from: "55558", upTo: null, rate: "0.43" },
];

/** Which transcribed grid a 2026 versement falls under. */
export type FrPasEdition = "may2025" | "may2026";

/**
 * Resolve the grille edition for a versement date (ISO YYYY-MM-DD).
 *
 * The May-2026 grids apply "à compter du 1er mai 2026"; earlier 2026
 * versements use the May-2025 grids. This is the strict rule ("le débiteur
 * de la retenue à la source applique la grille en vigueur à la date du
 * versement", BOI-IR-PAS-20-20-30-10 §120): the admis one-month late
 * adoption tolerance is documented in ./compute-statutory.ts, not modelled.
 */
export function frPasEditionForVersement(payDate: string): FrPasEdition {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    throw new PayrollPackError(
      `FR PAS edition resolution needs an ISO versement date (YYYY-MM-DD), got "${payDate}"`,
    );
  }
  if (payDate < "2026-01-01" || payDate > "2026-12-31") {
    throw new PayrollPackError(
      `FR PAS has no transcribed grille for versements dated ${payDate}: `
      + "the FR pack transcribes calendar 2026 only "
      + "(BOI-BAREME-000037-20250410 and -20260407). Transcribe the year's "
      + "tables into engine/src/payroll/fr/ first.",
    );
  }
  return payDate < "2026-05-01" ? "may2025" : "may2026";
}

/**
 * Monthly-base lookup over bigint minor units (1e4, the repo's money.ts
 * scale): first band with from <= base < upTo. Integer comparison — no
 * float, no string-length tricks. Negative bases are rejected by the caller.
 */
export function frPasDefaultRateUnits(
  monthlyBaseUnits: bigint,
  bands: readonly FrPasBand[],
): string {
  for (const band of bands) {
    if (monthlyBaseUnits < toUnits(band.from)) continue;
    if (band.upTo !== null && monthlyBaseUnits >= toUnits(band.upTo)) continue;
    return band.rate;
  }
  throw new PayrollPackError(
    "FR PAS grille lookup fell through: the transcribed grids start at 0 "
    + "with no cap, so this is an engine defect, not a table gap.",
  );
}

/**
 * Plafond de la Sécurité sociale 2026 — service-public.gouv.fr, actualité
 * A15386, quoting "L'arrêté du 22 décembre 2025 portant fixation du plafond
 * de la sécurité sociale pour l'année 2026 … indique qu'à compter du 1er
 * janvier 2026 : la valeur mensuelle du plafond s'élève à 4 005 €
 * (contre 3 925 € en 2025) … la valeur journalière du plafond s'élève à
 * 220 €", and "Pour l'année 2026, les différentes valeurs du plafond de la
 * sécurité sociale sont les suivantes : 48 060 € en valeur annuelle ;
 * 12 015 € en valeur trimestrielle ; 4 005 € en valeur mensuelle ; 924 €
 * en valeur hebdomadaire ; 220 € en valeur journalière ; 30 € en valeur
 * horaire."
 *
 * Transcribed because the plafond drives the contribution tranches; no
 * contribution engine consumes it yet (see FR_REFUSED_2026). Mayotte's
 * monthly ceiling ("sera fixé à 3 022 € au 1er janvier 2026", same page) is
 * recorded here and not implemented.
 */
export const FR_PASS_2026 = {
  annual: "48060",
  quarterly: "12015",
  monthly: "4005",
  weekly: "924",
  daily: "220",
  hourly: "30",
  mayotteMonthly: "3022",
} as const;

/**
 * Contrats-courts abattement figures, transcribed but NOT applied by the
 * engine: BOI-BAREME-000037 §IV — "Le montant mensuel net imposable du
 * salaire minimum de croissance s'élève, au 1er janvier 2026, à 1 495,04
 * euros. Par suite, le montant de l'abattement applicable aux contrats
 * courts en vigueur à compter de cette même date est égal à 748 euros
 * (1 495,04 / 2)" (-20260407), then "s'élève, au 1er juin 2026, à 1 531,12
 * euros … est égal à 766 euros (1 531,12 / 2)" (-20260706, arrêté du
 * 22 mai 2026). Applying it needs contract start/end dates no pack channel
 * carries, so the engine refuses it by name (FR_REFUSED_2026) instead of
 * guessing.
 */
export const FR_CONTRATS_COURTS_ABATTEMENT_2026 = {
  from2026_01_01: "748",
  from2026_06_01: "766",
} as const;

/**
 * Named refusals: everything this file does not transcribe, with the
 * reason. The engine quotes these names back. Cotisation-side refusals
 * live in FR_COTISATION_REFUSALS_2026 (./cotisations-2026.ts).
 */
export const FR_REFUSED_2026: readonly string[] = [
  "Grilles II (Guadeloupe, Réunion, Martinique) and III (Guyane, Mayotte): domicile-keyed grids the pack has no domicile channel for — refused by domicile name, never approximated by grille I",
  "Contrats-courts abattement (748 € then 766 €, transcribed above): needs contract start/end dates no pack channel carries",
  "Non-monthly grille scaling beyond the §180 monthly-equivalent rule: weekly/intermittent multi-bulletin and replacement-income period methods are documented, not implemented",
  "URSSAF cotisations transcribed in ./cotisations-2026.ts and AGIRC-ARRCO (T1/T2, CEG, CET) in ./retraite-2026.ts; still refused: APEC (cadre channel), AT/MP and versement mobilité (tenant-declared by design), and the Alsace-Moselle 1,30 % salary supplement (no department channel)",
  "Complément de retenue à la source (option mechanics): taxpayer-side, declared and paid by the employee on impots.gouv.fr, never computed by the employer",
  "Grille-application tolerance month (BOI-IR-PAS-20-20-30-10 §120 admis late adoption): the engine applies the strict versement-date rule",
];
