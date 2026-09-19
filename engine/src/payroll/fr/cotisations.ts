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
 * - Reduced rates: maladie 7 % is refused by name (the URSSAF page states
 *   no income condition, so the engine applies the 13 % plein to every
 *   salary — see FR_COTISATION_REFUSALS_2026). Allocations familiales is
 *   the opposite case: CSS art. L241-6-1 states the income condition
 *   (3,45 % at or below 3,5 × SMIC, 5,25 % above), so the engine selects
 *   the rate from the annualised remuneration.
 * - Brut/net-imposable bridge (PAS assiette): CGI art. 204 A et s. with
 *   BOFiP BOI-IR-PAS-20-10-10 I-A §10 — the PAS rate hits the montant net
 *   imposable, i.e. brut minus the déductible employee lines (vieillesse,
 *   CSG 6,8 pts per CGI art. 154 quinquies, ARRCO and CEG salariaux per
 *   CGI art. 83 1°) while the non-déductible CSG fraction (2,4 pts) and
 *   the CRDS stay in the base (same article: "la fraction restante de la
 *   CSG, soit 2,4 points, demeure non déductible comme la CRDS"). The
 *   CET salariale is likewise non déductible (solidarity levy, no rights).
 *   calculateFrNetImposable2026 derives it; the adapter prices PAS on it.
 * - FNAL reads the employer's effectif and fail-closes when unknown:
 *   "effectif de moins de 50 salariés" → 0,10 % plafonné;
 *   "effectif de 50 salariés et plus" → 0,50 % sur la totalité.
 * - Rounding: no agency rule is quotable (neither page says "arrondi").
 *   Method (engine-stated, not agency-quoted): every line rounds half-up
 *   to the centime, caps resolve to exact centimes at monthly periodicity.
 *
 * Retraite complémentaire AGIRC-ARRCO (./retraite-2026.ts): T1 at the
 * 7,87 % appelé rate and T2 at 21,59 %, each split 60/40 in the engine
 * from the quoted totals; CEG 2,15 % (T1) and 2,70 % (T2) split the same
 * way; CET 0,35 % on the T1+T2 assiettes strictly above the plafond.
 *
 * What this pass does NOT do (named refusals, stated): APEC 0,06 %
 * (cadres only — no cadre-status channel), a conventionally modified
 * 60/40 split (no tenant-override channel), AT/MP and versement mobilité
 * (tenant-declared — the pure function accepts declared rates and prices
 * them, but no pack channel carries them to the adapter), the
 * Alsace-Moselle 1,30 % salary supplement (no department channel), the
 * AGS 0,03 % interim variant (no employer-type channel).
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
  FR_ALLOC_FAM_SEUIL_2026,
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
import {
  FR_ARRCO_TAUX_2026,
  FR_CEG_2026,
  FR_CET_2026,
  frRetraiteYearForPayDate,
} from "./retraite-2026.ts";

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
  /** The allocations familiales rate actually applied ("0.0345" or "0.0525"). */
  allocFamErRate: string;
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
  // Retraite complémentaire AGIRC-ARRCO (all 4dp).
  /** T1 assiette (capped at the PASS) and T2 assiette (0 above 8×PASS). */
  t1Base: string;
  t2Base: string;
  arrcoSalT1: string;
  arrcoErT1: string;
  arrcoSalT2: string;
  arrcoErT2: string;
  arrcoSal: string;
  arrcoEr: string;
  cegSalT1: string;
  cegErT1: string;
  cegSalT2: string;
  cegErT2: string;
  cegSal: string;
  cegEr: string;
  /** Whether the salaire exceeds the plafond (strict), triggering CET. */
  cetApplies: boolean;
  /** The T1+T2 assiette the CET is prélevée on (0 when not applied). */
  cetBase: string;
  cetSal: string;
  cetEr: string;
}

/**
 * Regulated 60/40 split of a quoted appelé total, done in the engine:
 * salarié 40 %, employeur 60 % (FR_ARRCO_SPLIT_QUOTE_2026). Exact at the
 * 1e6 rate scale for every 2026 total, so no rounding enters the split —
 * rounding happens once, per line, at the centime. The salarié share
 * rounds half-up and the employeur share is priced from its own exact
 * rate (parts can differ from a rounded total by one centime, stated).
 */
function split6040(totalRate6: bigint): { sal: bigint; er: bigint } {
  const sal = (totalRate6 * 40n) / 100n;
  if (totalRate6 * 40n !== sal * 100n) {
    throw new PayrollPackError(
      "FR 60/40 split is not exact at the rate scale: engine defect, not a table gap",
    );
  }
  return { sal, er: totalRate6 - sal };
}

export function calculateFrCotisations2026(
  input: FrCotisations2026Input,
): FrCotisations2026Result {
  frCotisationYearForPayDate(input.payDate);
  frRetraiteYearForPayDate(input.payDate);
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

  // Employer: maladie plein only (réduit refused by name). Allocations
  // familiales selects its rate from the annualised remuneration (CSS art.
  // L241-6-1, modalités D241-3-1): 3,45 % when brut × periods does not
  // exceed 3,5 × SMIC annuel, 5,25 % above. Bigint comparison — no float,
  // no centime rounding at the boundary; at monthly periodicity this is
  // exactly brut ≤ 3,5 × SMIC mensuel (6 380,605 €).
  const maladieEr = lineOf(brut, rate6(FR_MALADIE_ER_2026.plein.rate));
  const vieilErPlaf = lineOf(plafPer, rate6(FR_VIEILLESSE_ER_2026.plafonnee.rate));
  const vieilErDeplaf = lineOf(brut, rate6(FR_VIEILLESSE_ER_2026.deplafonnee.rate));
  const allocFamSeuilAnnual = U(FR_ALLOC_FAM_SEUIL_2026.annual);
  const allocFamAnnualised = brut * BigInt(periods);
  const allocFamRate = allocFamAnnualised <= allocFamSeuilAnnual
    ? FR_ALLOC_FAM_ER_2026.reduit.rate
    : FR_ALLOC_FAM_ER_2026.plein.rate;
  const allocFamEr = lineOf(brut, rate6(allocFamRate));
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

  // Retraite complémentaire: T1 up to the PASS, T2 from the PASS to 8×PASS.
  const t1Base = plafPer;
  const huitPass = passAnnual * 8n;
  const annualised = brut * BigInt(periods);
  const t2Annualised = annualised < passAnnual
    ? 0n
    : annualised - passAnnual > huitPass - passAnnual ? huitPass - passAnnual : annualised - passAnnual;
  const t2Base = roundDiv(t2Annualised, BigInt(periods));

  const arrcoT1 = split6040(rate6(FR_ARRCO_TAUX_2026.t1.rate));
  const arrcoT2 = split6040(rate6(FR_ARRCO_TAUX_2026.t2.rate));
  const cegT1 = split6040(rate6(FR_CEG_2026.t1.rate));
  const cegT2 = split6040(rate6(FR_CEG_2026.t2.rate));
  const cetSplit = split6040(rate6(FR_CET_2026.rate));

  const arrcoSalT1 = lineOf(t1Base, arrcoT1.sal);
  const arrcoErT1 = lineOf(t1Base, arrcoT1.er);
  const arrcoSalT2 = lineOf(t2Base, arrcoT2.sal);
  const arrcoErT2 = lineOf(t2Base, arrcoT2.er);
  const cegSalT1 = lineOf(t1Base, cegT1.sal);
  const cegErT1 = lineOf(t1Base, cegT1.er);
  const cegSalT2 = lineOf(t2Base, cegT2.sal);
  const cegErT2 = lineOf(t2Base, cegT2.er);

  // CET strictly above the plafond, prélevée on the T1+T2 assiettes.
  const cetApplies = annualised > passAnnual;
  const cetBase = cetApplies ? t1Base + t2Base : 0n;
  const cetSal = cetApplies ? lineOf(cetBase, cetSplit.sal) : 0n;
  const cetEr = cetApplies ? lineOf(cetBase, cetSplit.er) : 0n;

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
    allocFamErRate: allocFamRate,
    chomageEr: D(chomageEr),
    agsEr: D(agsEr),
    fnalEr: D(fnalEr),
    csaEr: D(csaEr),
    dialogueEr: D(dialogueEr),
    cdnEr: D(add(fnalEr, csaEr, dialogueEr, vmEr)),
    atmpEr: D(atmpEr),
    versementMobiliteEr: D(vmEr),
    t1Base: D(t1Base),
    t2Base: D(t2Base),
    arrcoSalT1: D(arrcoSalT1),
    arrcoErT1: D(arrcoErT1),
    arrcoSalT2: D(arrcoSalT2),
    arrcoErT2: D(arrcoErT2),
    arrcoSal: D(add(arrcoSalT1, arrcoSalT2)),
    arrcoEr: D(add(arrcoErT1, arrcoErT2)),
    cegSalT1: D(cegSalT1),
    cegErT1: D(cegErT1),
    cegSalT2: D(cegSalT2),
    cegErT2: D(cegErT2),
    cegSal: D(add(cegSalT1, cegSalT2)),
    cegEr: D(add(cegErT1, cegErT2)),
    cetApplies,
    cetBase: D(cetBase),
    cetSal: D(cetSal),
    cetEr: D(cetEr),
  };
}

export interface FrNetImposable2026Input {
  /** Salaire brut of the versement (income + primes), decimal. */
  brut: string;
  /** Pay date, ISO YYYY-MM-DD — must fall in calendar 2026. */
  payDate: string;
  /** Usual pay periodicity; 12 = monthly caps directly. */
  periodsPerYear: number;
}

export interface FrNetImposable2026Result {
  /** Déductible employee lines, each 4dp (centime-rounded like the payslip). */
  vieillesseSal: string;
  /** CSG 6,8 pts — the déductible fraction (CGI art. 154 quinquies). */
  csgDeductible: string;
  arrcoSal: string;
  cegSal: string;
  /** Non-déductible lines, kept in the base: CSG 2,4 pts, CRDS, CET sal. */
  csgNonDeductible: string;
  crds: string;
  cetSal: string;
  /** Brut minus ALL employee lines (the "net social" of the payslip). */
  netSocial: string;
  /** The PAS assiette: brut minus déductible lines only. */
  netImposable: string;
}

/**
 * Brut/net-imposable bridge for the PAS assiette (CGI art. 204 A et s.,
 * BOFiP BOI-IR-PAS-20-10-10 I-A §10: assiette = montant net imposable).
 *
 * Composition: brut − vieillesse − CSG 6,8 pts (CGI art. 154 quinquies) −
 * ARRCO − CEG (CGI art. 83 1°). The CSG 2,4 pts, the CRDS and the CET
 * salariale are non déductibles and stay in the base, i.e.
 * netImposable = netSocial + csgNonDeductible + crds + cetSal — the
 * identity the regression test pins so the add-back cannot silently drop.
 *
 * Needs no effectif: only employee lines enter, so this stays callable
 * where FNAL would refuse. Every line reuses the shared primitives
 * (cappedPerPeriod, lineOf, split6040) on the same inputs, so each figure
 * here equals its calculateFrCotisations2026 twin to the unit — asserted
 * in the goldens.
 */
export function calculateFrNetImposable2026(
  input: FrNetImposable2026Input,
): FrNetImposable2026Result {
  frCotisationYearForPayDate(input.payDate);
  frRetraiteYearForPayDate(input.payDate);
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear <= 0) {
    throw new PayrollPackError(
      `FR net imposable needs a positive integer periodsPerYear, got ${input.periodsPerYear}`,
    );
  }
  let brut: bigint;
  try {
    brut = U(input.brut);
  } catch {
    throw new PayrollPackError(`FR net imposable brut is not a decimal amount: "${input.brut}"`);
  }
  if (brut < 0n) {
    throw new PayrollPackError(`FR net imposable brut must be non-negative, got "${input.brut}"`);
  }

  const periods = input.periodsPerYear;
  const passAnnual = U("48060");
  const quatrePassAnnual = U("192240");

  const plafPer = cappedPerPeriod(brut, periods, passAnnual, "plafond");
  const largePer = cappedPerPeriod(brut, periods, quatrePassAnnual, "4 PASS");

  const vieillesse = rCent(roundDiv(plafPer * rate6(FR_VIEILLESSE_SAL_2026.plafonnee.rate), RATE6))
    + rCent(roundDiv(brut * rate6(FR_VIEILLESSE_SAL_2026.deplafonnee.rate), RATE6));
  const csgBase = rCent(roundDiv(largePer * BigInt(9825), BigInt(10000)));
  const csgDed = lineOf(csgBase, rate6(FR_CSG_SAL_2026.nonImposable.rate));
  const csgNonDed = lineOf(csgBase, rate6(FR_CSG_SAL_2026.imposable.rate));
  const crds = lineOf(csgBase, rate6(FR_CRDS_SAL_2026.rate));

  const t1Base = plafPer;
  const huitPass = passAnnual * 8n;
  const annualised = brut * BigInt(periods);
  const t2Annualised = annualised < passAnnual
    ? 0n
    : annualised - passAnnual > huitPass - passAnnual ? huitPass - passAnnual : annualised - passAnnual;
  const t2Base = roundDiv(t2Annualised, BigInt(periods));

  const arrcoT1 = split6040(rate6(FR_ARRCO_TAUX_2026.t1.rate));
  const arrcoT2 = split6040(rate6(FR_ARRCO_TAUX_2026.t2.rate));
  const cegT1 = split6040(rate6(FR_CEG_2026.t1.rate));
  const cegT2 = split6040(rate6(FR_CEG_2026.t2.rate));
  const cetSplit = split6040(rate6(FR_CET_2026.rate));

  const arrco = lineOf(t1Base, arrcoT1.sal) + lineOf(t2Base, arrcoT2.sal);
  const ceg = lineOf(t1Base, cegT1.sal) + lineOf(t2Base, cegT2.sal);
  const cetApplies = annualised > passAnnual;
  const cet = cetApplies ? lineOf(t1Base + t2Base, cetSplit.sal) : 0n;

  // Payslip arithmetic on centime-rounded lines: net social first, then the
  // non-déductible add-back. netImposable is equivalently brut minus the
  // déductible lines — both forms are returned so tests pin the identity.
  const netSocial = brut - vieillesse - (csgDed + csgNonDed) - crds - arrco - ceg - cet;
  const netImposable = netSocial + csgNonDed + crds + cet;

  return {
    vieillesseSal: D(vieillesse),
    csgDeductible: D(csgDed),
    arrcoSal: D(arrco),
    cegSal: D(ceg),
    csgNonDeductible: D(csgNonDed),
    crds: D(crds),
    cetSal: D(cet),
    netSocial: D(netSocial),
    netImposable: D(netImposable),
  };
}
