/**
 * The FR pack's statutory pass: PAS (prélèvement à la source) for calendar
 * 2026.
 *
 * Method (agency-stated, quoted from BOI-IR-PAS-20-20-30-10, current
 * version 20230626, bofip.impots.gouv.fr):
 *
 * - Subsidiarity: "lorsque le débiteur de la retenue à la source ne dispose
 *   pas d'un taux transmis par l'administration fiscale, il applique …
 *   un taux proportionnel, dit par défaut" (§1); "L'application de la
 *   grille de taux par défaut présente toujours un caractère subsidiaire
 *   par rapport au taux transmis par l'administration fiscale" (§110);
 *   "un débiteur ne peut pas utiliser la grille de taux par défaut s'il
 *   dispose d'un taux valide transmis par l'administration fiscale" (§110).
 *   The transmitted rate is a DGFiP fact the employer copies, never
 *   computes — modelled as the declared `taux_transmis` certificate input.
 * - Base: monthly ("Ces grilles de taux sont déterminées en fonction d'une
 *   base mensuelle de versement", §90). Exceptional payments join the
 *   month's versement: "Pour une prime de 1 000 € versée avec un salaire
 *   mensuel de 2 000 €, le taux … est celui correspondant à un versement
 *   de 3 000 €" — so base = income + nonPeriodic of the versement.
 * - Non-monthly periodicity: the §180 monthly-equivalent rule — scale the
 *   versement to its monthly equivalent for the lookup, then apply the
 *   found rate to the actual versement ("600 x 7,5 %, soit 45 € par
 *   versement"). "Les montants obtenus sont arrondis au centime le plus
 *   proche, la fraction de centime égale à 0,50 étant comptée pour 1."
 * - Grille in force: "le débiteur de la retenue à la source applique la
 *   grille en vigueur à la date du versement" (§120), resolved by
 *   versement month in ./tables-2026.ts (May-2025 grids Jan–Apr 2026,
 *   May-2026 grids from May 2026). The §120 admis late-adoption tolerance
 *   is documented, not modelled (FR_REFUSED_2026).
 * - Domicile: "Trois grilles de taux par défaut … la première s'appliquant
 *   aux contribuables domiciliés en métropole ou hors de France, la
 *   deuxième aux contribuables domiciliés en Guadeloupe, à La Réunion et
 *   en Martinique et la troisième aux contribuables domiciliés en Guyane
 *   et à Mayotte" (§90). Only grille I is transcribed; any other domicile
 *   is refused by name — never approximated by grille I.
 *
 * What this pass does NOT do (stated): APEC (cadres only, no channel),
 * a conventionally modified 60/40 split, AT/MP and versement mobilité
 * (tenant-declared, no context channel), the Alsace-Moselle salary
 * supplement, the AGS interim variant, and PAS reduced-rate modulation.
 * The brut/net-imposable bridge IS modelled: the stub's earnings figure
 * is the brut, and the PAS assiette is derived by
 * calculateFrNetImposable2026 (see ./cotisations.ts) — the rate never
 * hits the brut (CGI art. 204 A et s., BOI-IR-PAS-20-10-10 I-A §10).
 *
 * Money: bigint units (1e4) throughout via the repo's money.ts, halves away
 * from zero (roundDiv) — the same discipline as canada/decimal.ts. The
 * final PAS is exact to the centime; pushed at 4dp like every statutory
 * line. Never floating point.
 */
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import {
  FR_PAS_METROPOLE_MAY2025,
  FR_PAS_METROPOLE_MAY2026,
  frPasDefaultRateUnits,
  frPasEditionForVersement,
} from "./tables-2026.ts";
import { calculateFrCotisations2026, calculateFrNetImposable2026 } from "./cotisations.ts";

const U = (s: string): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);

const RATE6 = 1_000_000n;
const CENT_UNITS = 100n;

/** Exact 1e6-scale rate from a decimal fraction string ("0.029"). */
function rate6(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new PayrollPackError(`FR PAS rate is not a plain decimal: "${value}"`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * RATE6 + BigInt((fraction + "000000").slice(0, 6));
}

/** Exact 1e6-scale rate from a PERCENT string ("2.9" means 2.9 %). */
function percent6(value: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new PayrollPackError(
      `FR PAS transmitted rate is not a percent with at most two decimals: "${value}"`,
    );
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * RATE6 + BigInt((fraction + "00").slice(0, 2)) * 10_000n;
}

/** Round units half-up to the centime. */
function rCent(u: bigint): bigint {
  return roundDiv(u, CENT_UNITS) * CENT_UNITS;
}

export type FrDomicile = "metropole_hors_france";

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. PAS/TAUX_PAS are the prélèvement's own terms and
 * the cotisations carry their statutory names — see the pack's PAS grille
 * basis.
 */
export const FR_FACTOR_LABELS: Readonly<Record<string, string>> = {
  BASE: "Assiette mensuelle PAS",
  TAUX_PAS: "Taux PAS",
  PAS: "Prélèvement à la source",
  BRUT: "Salaire brut",
  NET_IMPOSABLE: "Net imposable (assiette PAS)",
  VIEIL_SAL: "Vieillesse (salariale)",
  CSG: "Contribution sociale généralisée (CSG)",
  CRDS: "Contribution au remboursement de la dette sociale (CRDS)",
  MAL_ER: "Maladie (employeur)",
  VIEIL_ER: "Vieillesse (employeur)",
  FAM_ER: "Allocations familiales (employeur)",
  CHOM_ER: "Assurance chômage (employeur)",
  AGS_ER: "Cotisation AGS (employeur)",
  CDN_ER: "FNAL, CSA et dialogue social (employeur)",
  ARRCO_SAL: "Retraite complémentaire (salariale)",
  ARRCO_ER: "Retraite complémentaire (employeur)",
  CEG_SAL: "Contribution d'équilibre général (salariale)",
  CEG_ER: "Contribution d'équilibre général (employeur)",
  CET_SAL: "Contribution d'équilibre technique (salariale)",
  CET_ER: "Contribution d'équilibre technique (employeur)",
};

export interface FrPas2026Input {
  /** Montant net imposable du versement (income + primes), decimal. */
  base: string;
  /** Versement date, ISO YYYY-MM-DD — selects the grille edition. */
  payDate: string;
  /** Usual pay periodicity; 12 = monthly grille directly. */
  periodsPerYear: number;
  /** DGFiP-transmitted rate, percent ("7.5" means 7.5 %); null = grille. */
  transmittedRatePct: string | null;
  /** Fail-closed: only métropole computes; DOM values never reach here. */
  domicile: FrDomicile;
}

export interface FrPas2026Result {
  /** Monthly-equivalent base used for the grille lookup, 4dp. */
  monthlyBase: string;
  /** Applied rate as a percent, 4dp ("2.9000" means 2.9 %). */
  ratePct: string;
  /** "grille" or "transmis". */
  rateSource: "grille" | "transmis";
  /** PAS withholding for the versement, 4dp. */
  pas: string;
}

export function calculateFrPas2026(input: FrPas2026Input): FrPas2026Result {
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear <= 0) {
    throw new PayrollPackError(
      `FR PAS monthly-equivalent scaling needs a positive integer periodsPerYear, got ${input.periodsPerYear}`,
    );
  }
  let base: bigint;
  try {
    base = U(input.base);
  } catch {
    throw new PayrollPackError(`FR PAS base is not a decimal amount: "${input.base}"`);
  }
  if (base < 0n) {
    throw new PayrollPackError(`FR PAS base must be non-negative, got "${input.base}"`);
  }
  if (input.domicile !== "metropole_hors_france") {
    throw new PayrollPackError(
      `FR PAS grille lookup refused for domicile "${input.domicile}": only `
      + "grille I (métropole ou hors de France) is transcribed — grilles II "
      + "(Guadeloupe, Réunion, Martinique) and III (Guyane, Mayotte) are "
      + "refused by name, never approximated (see FR_REFUSED_2026).",
    );
  }
  const edition = frPasEditionForVersement(input.payDate);
  const bands = edition === "may2025" ? FR_PAS_METROPOLE_MAY2025 : FR_PAS_METROPOLE_MAY2026;

  // Monthly equivalent for the lookup (§180), rounded to the centime.
  const monthlyBase = input.periodsPerYear === 12
    ? rCent(base)
    : rCent(roundDiv(base * BigInt(input.periodsPerYear), 12n));

  let ratePct6: bigint;
  let rateSource: FrPas2026Result["rateSource"];
  if (input.transmittedRatePct !== null && input.transmittedRatePct !== "") {
    const p6 = percent6(input.transmittedRatePct);
    if (p6 < 0n || p6 > 100n * RATE6) {
      throw new PayrollPackError(
        `FR PAS transmitted rate out of range 0–100 %: "${input.transmittedRatePct}"`,
      );
    }
    ratePct6 = p6;
    rateSource = "transmis";
  } else {
    const fraction = frPasDefaultRateUnits(monthlyBase, bands);
    ratePct6 = rate6(fraction) * 100n;
    rateSource = "grille";
  }

  // PAS = rate × the actual versement, half-up to the centime.
  const pasUnits = roundDiv(base * ratePct6, 100n * RATE6 * CENT_UNITS) * CENT_UNITS;

  return {
    monthlyBase: D(monthlyBase),
    ratePct: D(ratePct6 / 100n),
    rateSource,
    pas: D(pasUnits),
  };
}

/**
 * Pack adapter: reads the versement from the run, the domicile and the
 * transmitted rate from the `fr_pas_option` certificate, pushes the PAS
 * line. Refuses anything but taxYear 2026 and anything but an affirmed
 * métropole domicile — silence here would be wrong money.
 */
export async function computeFrStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const { taxYear, region, run, income, nonPeriodic, periodsPerYear, pushStatutory, certificateFor, employerEmployeeCount } = ctx;
  if (taxYear !== 2026) {
    throw new PayrollPackError(
      `FR PAS withholding for tax year ${taxYear} has not been transcribed `
      + "— the FR payroll pack's only transcribed year is calendar 2026 "
      + "(see engine/src/payroll/fr/tables-2026.ts). Transcribe the year's "
      + "grids before calculating",
    );
  }
  if (region !== "FR") {
    throw new PayrollPackError(
      `FR PAS withholding for region "${region}" is not supported: the pack `
      + "knows one national region, FR — PAS is national. DOM grilles II and "
      + "III are keyed by domicile on the fr_pas_option certificate, not by "
      + "region, and are refused below by domicile name.",
    );
  }
  const payDate = run["pay_date"];
  if (!payDate) {
    throw new PayrollPackError(
      "FR PAS needs the versement date (run pay_date) to select the grille "
      + "edition in force — January–April 2026 versements use the May-2025 "
      + "grids, May–December the May-2026 grids.",
    );
  }
  const answers = certificateFor("fr_pas_option")?.answers ?? {};
  const domicile = answers["domicile"];
  if (domicile === "guadeloupe_reunion_martinique") {
    throw new PayrollPackError(
      "FR PAS grille lookup refused: domicile Guadeloupe / Réunion / "
      + "Martinique uses grille II, which is not transcribed "
      + "(see FR_REFUSED_2026). Grille I (métropole) is never substituted.",
    );
  }
  if (domicile === "guyane_mayotte") {
    throw new PayrollPackError(
      "FR PAS grille lookup refused: domicile Guyane / Mayotte uses grille "
      + "III, which is not transcribed (see FR_REFUSED_2026). Grille I "
      + "(métropole) is never substituted.",
    );
  }
  if (domicile !== "metropole_hors_france") {
    throw new PayrollPackError(
      "FR PAS needs an affirmed domicile (fr_pas_option … domicile = "
      + "metropole_hors_france): the three grilles differ by domicile and "
      + "an undeclared domicile must not fall through to grille I.",
    );
  }
  const transmitted = answers["taux_transmis"] ?? null;
  const base = D(U(income) + U(nonPeriodic === "" ? "0" : nonPeriodic));
  // The stub's earnings figure is the brut. PAS prices on the net imposable
  // derived from it (CGI art. 204 A et s., BOI-IR-PAS-20-10-10 I-A §10) —
  // never on the brut. Cotisations price on the brut below.
  const net = calculateFrNetImposable2026({
    brut: base,
    payDate,
    periodsPerYear,
  });
  const result = calculateFrPas2026({
    base: net.netImposable,
    payDate,
    periodsPerYear,
    transmittedRatePct: transmitted === "" ? null : transmitted,
    domicile: "metropole_hors_france",
  });
  pushStatutory("pas", "deduction", "Prélèvement à la source", result.pas, 110);
  // Cotisations price on the brut. AT/MP and versement mobilité have no
  // context channel for their tenant-declared rates, so those lines are
  // not pushed.
  const cots = calculateFrCotisations2026({
    brut: base,
    payDate,
    periodsPerYear,
    employerEmployeeCount: employerEmployeeCount ?? null,
    atmpRatePct: null,
    versementMobilitePct: null,
  });
  pushStatutory("vieillesse", "deduction", "Assurance vieillesse (salariale)", cots.vieillesseSal, 120);
  pushStatutory("csg", "deduction", "CSG (salariale)", cots.csg, 130);
  pushStatutory("crds", "deduction", "CRDS (salariale)", cots.crds, 135);
  pushStatutory("maladie_er", "employer_contribution", "Assurance maladie (employeur)", cots.maladieEr, 210);
  pushStatutory("vieillesse_er", "employer_contribution", "Assurance vieillesse (employeur)", cots.vieillesseEr, 211);
  pushStatutory("allocfam_er", "employer_contribution", "Allocations familiales (employeur)", cots.allocFamEr, 215);
  pushStatutory("chomage_er", "employer_contribution", "Assurance chômage (employeur)", cots.chomageEr, 225);
  pushStatutory("ags_er", "employer_contribution", "Cotisation AGS (employeur)", cots.agsEr, 226);
  pushStatutory("cdn_er", "employer_contribution", "FNAL, CSA et dialogue social (employeur)", cots.cdnEr, 230);
  pushStatutory("arrco", "deduction", "Retraite complémentaire (salariale)", cots.arrcoSal, 140);
  pushStatutory("arrco", "employer_contribution", "Retraite complémentaire (employeur)", cots.arrcoEr, 240);
  pushStatutory("ceg", "deduction", "Contribution d'équilibre général (salariale)", cots.cegSal, 141);
  pushStatutory("ceg", "employer_contribution", "Contribution d'équilibre général (employeur)", cots.cegEr, 241);
  pushStatutory("cet", "deduction", "Contribution d'équilibre technique (salariale)", cots.cetSal, 142);
  pushStatutory("cet", "employer_contribution", "Contribution d'équilibre technique (employeur)", cots.cetEr, 242);
  return {
    BASE: result.monthlyBase,
    TAUX_PAS: result.ratePct,
    PAS: result.pas,
    BRUT: base,
    NET_IMPOSABLE: net.netImposable,
    VIEIL_SAL: cots.vieillesseSal,
    CSG: cots.csg,
    CRDS: cots.crds,
    MAL_ER: cots.maladieEr,
    VIEIL_ER: cots.vieillesseEr,
    FAM_ER: cots.allocFamEr,
    CHOM_ER: cots.chomageEr,
    AGS_ER: cots.agsEr,
    CDN_ER: cots.cdnEr,
    ARRCO_SAL: cots.arrcoSal,
    ARRCO_ER: cots.arrcoEr,
    CEG_SAL: cots.cegSal,
    CEG_ER: cots.cegEr,
    CET_SAL: cots.cetSal,
    CET_ER: cots.cetEr,
  };
}
