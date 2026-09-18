/**
 * The FR pack's 2026 cotisation pass: URSSAF employee and employer
 * contributions from the transcribed tables in ./cotisations-2026.ts.
 *
 * Method (page-stated, quoted from the URSSAF taux secteur privé page):
 *
 * - Plafonnée lines apply "dans la limite du plafond" (vieillesse) or
 *   "dans la limite de 192 240 € en 2026" (chômage, AGS, CSG/CRDS);
 *   déplafonnée lines apply "sur la totalité". The 192 240 € cap is
 *   4 × PASS (48 060 €, plafonds page) — asserted, not re-transcribed.
 * - CSG/CRDS base: "sur 98,25 % du salaire brut". The abattement is built
 *   FIRST and the rate applied to the abated base — never rate × brut.
 *   Cap order (engine-stated, the page is silent): the 192 240 € limit
 *   applies to the brut, then the 98,25 % abattement applies to the capped
 *   figure, i.e. base = min(brut, cap) × 98,25 %.
 * - Reduced rates (maladie 7 %, allocations 3,45 %) are refused by name:
 *   the page states no income condition, so the engine applies the taux
 *   plein to every salary and never the réduit (see
 *   FR_COTISATION_REFUSALS_2026).
 * - FNAL reads the employer's effectif and fail-closes when unknown:
 *   "effectif de moins de 50 salariés" → 0,10 % plafonné;
 *   "effectif de 50 salariés et plus" → 0,50 % sur la totalité.
 * - Rounding: no agency rule is quotable (neither page says "arrondi").
 *   Method (engine-stated, not agency-quoted): every line rounds half-up
 *   to the centime, caps resolve to exact centimes at monthly periodicity.
 *
 * What this pass does NOT do (named refusals, stated): AGIRC-ARRCO (no
 * obtainable rates), AT/MP and versement mobilité (tenant-declared — the
 * pure function accepts declared rates and prices them, but no pack
 * channel carries them to the adapter), the Alsace-Moselle 1,30 %
 * salary supplement (no department channel), the AGS 0,03 % interim
 * variant (no employer-type channel).
 *
 * Money: bigint units (1e4) throughout via the repo's money.ts, halves
 * away from zero (roundDiv) — the same discipline as ./compute-statutory.ts
 * and canada/decimal.ts. Never floating point.
 */
import { fromUnits, roundDiv, toUnits } from "../../money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import {
  FR_AGS_ER_2026,
  FR_ALLOC_FAM_ER_2026,
  FR_CHOMAGE_ER_2026,
  FR_CRDS_SAL_2026,
  FR_CSA_ER_2026,
  FR_CSG_SAL_2026,
  FR_DIALOGUE_SOCIAL_ER_2026,
  FR_FNAL_ER_2026,
  FR_MALADIE_ER_2026,
  FR_VIEILLESSE_ER_2026,
  FR_VIEILLESSE_SAL_2026,
  frCotisationYearForPayDate,
} from "./cotisations-2026.ts";

const U = (s: string): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);

const RATE6 = 1_000_000n;
const CENT_UNITS = 100n;

/** Exact 1e6-scale rate from a table fraction string ("0.0855"). */
function rate6(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new PayrollPackError(`FR cotisation rate is not a plain decimal: "${value}"`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * RATE6 + BigInt((fraction + "000000").slice(0, 6));
}

/** Exact 1e6-scale rate from a tenant PERCENT string ("1.1" means 1.1 %). */
function percent6(value: string, what: string): bigint {
  if (!/^\d+(\.\d{1,4})?$/.test(value)) {
    throw new PayrollPackError(
      `FR ${what} is not a percent with at most four decimals: "${value}"`,
    );
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const pct6 = BigInt(whole) * RATE6 + BigInt((fraction + "000000").slice(0, 6));
  if (pct6 < 0n || pct6 > 100n * RATE6) {
    throw new PayrollPackError(`FR ${what} out of range 0–100 %: "${value}"`);
  }
  return pct6;
}

/** Round units half-up to the centime. */
function rCent(u: bigint): bigint {
  return roundDiv(u, CENT_UNITS) * CENT_UNITS;
}

/** rate (1e6 fraction scale) × base units, half-up to the centime. */
function lineOf(baseUnits: bigint, rate: bigint): bigint {
  return rCent(roundDiv(baseUnits * rate, RATE6));
}

/**
 * Annual-cap base scaled to one pay period: min(base × periods, cap) ÷
 * periods, half-up. Exact to the centime whenever the cap divides evenly
 * (both 2026 caps do at monthly periodicity: 48 060/12 = 4 005,
 * 192 240/12 = 16 020).
 */
function cappedPerPeriod(
  baseUnits: bigint,
  periodsPerYear: number,
  capAnnualUnits: bigint,
  what: string,
): bigint {
  const annualised = baseUnits * BigInt(periodsPerYear);
  const capped = annualised < capAnnualUnits ? annualised : capAnnualUnits;
  const per = roundDiv(capped, BigInt(periodsPerYear));
  if (per < 0n) {
    throw new PayrollPackError(`FR ${what} capped base went negative: engine defect`);
  }
  return per;
}

export interface FrCotisations2026Input {
  /** Salaire brut of the versement (income + primes), decimal. */
  brut: string;
  /** Pay date, ISO YYYY-MM-DD — must fall in calendar 2026. */
  payDate: string;
  /** Usual pay periodicity; 12 = monthly caps directly. */
  periodsPerYear: number;
  /**
   * Employer's effectif for the FNAL 50-salarié threshold, isolated to
   * its legal entity. null = unknown → the engine REFUSES (named FNAL
   * refusal) rather than assuming a size.
   */
  employerEmployeeCount: number | null;
  /** Tenant-declared AT/MP rate as a percent ("1.1" = 1.1 %); null = undeclared. */
  atmpRatePct?: string | null;
  /** Tenant-declared versement mobilité rate as a percent; null = undeclared. */
  versementMobilitePct?: string | null;
}

export interface FrCotisations2026Result {
  // Employee deductions (all 4dp).
  vieillesseSalPlafonnee: string;
  vieillesseSalDeplafonnee: string;
  vieillesseSal: string;
  /** The abated CSG/CRDS base actually rated (min(brut, cap) × 98,25 %). */
  csgBase: string;
  csgImposable: string;
  csgNonImposable: string;
  csg: string;
  crds: string;
  // Employer contributions (all 4dp).
  maladieEr: string;
  vieillesseErPlafonnee: string;
  vieillesseErDeplafonnee: string;
  vieillesseEr: string;
  allocFamEr: string;
  chomageEr: string;
  agsEr: string;
  fnalEr: string;
  csaEr: string;
  dialogueEr: string;
  /** FNAL + CSA + dialogue social + versement mobilité (the CDN-ER line). */
  cdnEr: string;
  /** 0.0000 unless a tenant rate was declared. */
  atmpEr: string;
  /** 0.0000 unless a tenant rate was declared. */
  versementMobiliteEr: string;
}

export function calculateFrCotisations2026(
  input: FrCotisations2026Input,
): FrCotisations2026Result {
  frCotisationYearForPayDate(input.payDate);
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear <= 0) {
    throw new PayrollPackError(
      `FR cotisations need a positive integer periodsPerYear, got ${input.periodsPerYear}`,
    );
  }
  let brut: bigint;
  try {
    brut = U(input.brut);
  } catch {
    throw new PayrollPackError(`FR cotisations brut is not a decimal amount: "${input.brut}"`);
  }
  if (brut < 0n) {
    throw new PayrollPackError(`FR cotisations brut must be non-negative, got "${input.brut}"`);
  }

  const periods = input.periodsPerYear;
  const passAnnual = U("48060");
  const quatrePassAnnual = U("192240");

  const plafPer = cappedPerPeriod(brut, periods, passAnnual, "plafond");
  const largePer = cappedPerPeriod(brut, periods, quatrePassAnnual, "4 PASS");

  // Employee vieillesse: 6,90 % plafonnée + 0,40 % déplafonnée.
  const vieilSalPlaf = lineOf(plafPer, rate6(FR_VIEILLESSE_SAL_2026.plafonnee.rate));
  const vieilSalDeplaf = lineOf(brut, rate6(FR_VIEILLESSE_SAL_2026.deplafonnee.rate));

  // CSG/CRDS on the abated base — the classic defect is rate × brut.
  const csgBase = rCent(roundDiv(largePer * BigInt(9825), BigInt(10000)));
  const csgImp = lineOf(csgBase, rate6(FR_CSG_SAL_2026.imposable.rate));
  const csgNonImp = lineOf(csgBase, rate6(FR_CSG_SAL_2026.nonImposable.rate));
  const crds = lineOf(csgBase, rate6(FR_CRDS_SAL_2026.rate));

  // Employer: plein rates only (réduit refused by name).
  const maladieEr = lineOf(brut, rate6(FR_MALADIE_ER_2026.plein.rate));
  const vieilErPlaf = lineOf(plafPer, rate6(FR_VIEILLESSE_ER_2026.plafonnee.rate));
  const vieilErDeplaf = lineOf(brut, rate6(FR_VIEILLESSE_ER_2026.deplafonnee.rate));
  const allocFamEr = lineOf(brut, rate6(FR_ALLOC_FAM_ER_2026.plein.rate));
  const chomageEr = lineOf(largePer, rate6(FR_CHOMAGE_ER_2026.rate.rate));
  const agsEr = lineOf(largePer, rate6(FR_AGS_ER_2026.rate.rate));
  const csaEr = lineOf(brut, rate6(FR_CSA_ER_2026.rate));
  const dialogueEr = lineOf(brut, rate6(FR_DIALOGUE_SOCIAL_ER_2026.rate));

  // FNAL: effectif decides; unknown effectif fail-closes.
  const count = input.employerEmployeeCount;
  if (count === null || count === undefined) {
    throw new PayrollPackError(
      "FR FNAL refuses: employerEmployeeCount is unknown — the 0,10 % "
      + "plafonné (< 50 salariés) vs 0,50 % sur la totalité (≥ 50) choice "
      + "cannot be made without the employer's effectif "
      + "(see FR_COTISATION_REFUSALS_2026).",
    );
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new PayrollPackError(
      `FR FNAL needs a non-negative integer employerEmployeeCount, got ${count}`,
    );
  }
  const fnalEr = count >= 50
    ? lineOf(brut, rate6(FR_FNAL_ER_2026.cinquanteEtPlus.rate))
    : lineOf(plafPer, rate6(FR_FNAL_ER_2026.moins50.rate));

  // Tenant-declared: priced when declared, zero and pushed nowhere when not.
  const atmpPct = input.atmpRatePct ?? null;
  const atmpEr = atmpPct === null || atmpPct === ""
    ? 0n
    : lineOf(brut, percent6(atmpPct, "taux AT/MP") / 100n);
  const vmPct = input.versementMobilitePct ?? null;
  const vmEr = vmPct === null || vmPct === ""
    ? 0n
    : lineOf(brut, percent6(vmPct, "taux versement mobilité") / 100n);

  const add = (...units: bigint[]): bigint => units.reduce((a, b) => a + b, 0n);

  return {
    vieillesseSalPlafonnee: D(vieilSalPlaf),
    vieillesseSalDeplafonnee: D(vieilSalDeplaf),
    vieillesseSal: D(add(vieilSalPlaf, vieilSalDeplaf)),
    csgBase: D(csgBase),
    csgImposable: D(csgImp),
    csgNonImposable: D(csgNonImp),
    csg: D(add(csgImp, csgNonImp)),
    crds: D(crds),
    maladieEr: D(maladieEr),
    vieillesseErPlafonnee: D(vieilErPlaf),
    vieillesseErDeplafonnee: D(vieilErDeplaf),
    vieillesseEr: D(add(vieilErPlaf, vieilErDeplaf)),
    allocFamEr: D(allocFamEr),
    chomageEr: D(chomageEr),
    agsEr: D(agsEr),
    fnalEr: D(fnalEr),
    csaEr: D(csaEr),
    dialogueEr: D(dialogueEr),
    cdnEr: D(add(fnalEr, csaEr, dialogueEr, vmEr)),
    atmpEr: D(atmpEr),
    versementMobiliteEr: D(vmEr),
  };
}
