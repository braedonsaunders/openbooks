import { toCents } from "../../money.ts";
import { PayrollError } from "../../payroll-error.ts";
import {
  certificateAmount,
  certificateChoice,
  certificateFlag,
  type ResolvedCertificate,
} from "../certificates.ts";
import type {
  PayrollStatutoryComputeContext,
} from "../statutory-context.ts";
import {
  NL_AHK_2026,
  NL_AOK_2026,
  NL_ARK_2026,
  NL_BRACKETS_2026,
  NL_EMPLOYER_PREMIUMS_2026,
  NL_JGK_2026,
  NL_JGK_2026_AOW,
  NL_LMAX_2026,
  NL_LV_2026,
  NL_MAX_PREMIUM_WAGE_2026,
  NL_MAX_PREMIUM_WAGE_ANNUAL_2026,
  NL_OUK_2026,
  NL_PERIOD_FACTORS_2026,
  NL_TRANSCRIBED_YEARS_2026,
  NL_ZVW_2026,
  type NlAgeClass,
} from "./rates.ts";

/**
 * The 2026 loonheffing engine: the Belastingdienst's Rekenvoorschriften voor
 * de geautomatiseerde loonadministratie as a pure function.
 *
 * Method (§2.1): herleid the period wage to a jaarloon L (floor to a multiple
 * of Lv = € 54 below Lmax), price L through the schijventarief (X1), subtract
 * the heffingskortingen after afbouw (X, floored at € 0 with the statutory
 * capping order AOK, ARK, OUK, AHK), and herleid back to the period
 * (x = X/F, "u x rekenkundig afrondt op 2 decimalen").
 *
 * Above Lmax the engine uses systematiek 1 (the tijdvaktabel systematiek,
 * §2.2.4): "x = y + xboven", with y the withholding at Lmax and the top
 * schijf rate over the period-wage difference, "u xboven naar beneden
 * afrondt op 2 decimalen". Both systematieken are permitted there ("De
 * uitkomst van de rekenregel kan gering verschillen van die van de
 * tabelsystematiek. Dat is toegestaan.").
 *
 * Money is integer eurocents (bigint) throughout; every rounding below is
 * the publication's own rule, quoted at the step. No floating point.
 */

// ---------------------------------------------------------------------------
// Exact decimal parsing
// ---------------------------------------------------------------------------

/**
 * Pipeline money → eurocents through the ledger's own boundary (money.ts
 * `toCents`, the pack-interface contract on `PayrollStatutoryComputeContext`).
 * Accepts every shape the pipeline emits — "0.0000" included — and rounds a
 * sub-cent fraction half-up to the cent ("rekenkundig", the publications'
 * own word for their per-step rounding). Negatives are refused by name: the
 * loonheffing bases are non-negative by construction.
 */
function parseCents(value: string, what: string): bigint {
  let cents: bigint;
  try {
    cents = toCents(value);
  } catch {
    throw new PayrollError(`the NL payroll pack cannot price ${what}: "${value}" is not a non-negative money amount`);
  }
  if (cents < 0n) throw new PayrollError(`the NL payroll pack cannot price ${what}: "${value}" is not a non-negative money amount`);
  return cents;
}

/** A rate with up to 5 decimals → integer per 100000 (the voorschriften give factors to 5). */
function parseRate5(value: string, what: string): bigint {
  const raw = value.trim();
  const m = /^(\d+)(?:\.(\d{1,5}))?$/.exec(raw);
  if (!m) throw new PayrollError(`the NL payroll pack cannot price ${what}: "${value}" is not a rate with at most 5 decimals`);
  return BigInt(m[1]!) * 100000n + BigInt(((m[2] ?? "") + "00000").slice(0, 5));
}

/** A whole-percent or 2-decimal percent → integer per 100. */
function parseRate2(value: string, what: string): bigint {
  const raw = value.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) throw new PayrollError(`the NL payroll pack cannot price ${what}: "${value}" is not a percentage`);
  return BigInt(m[1]!) * 100n + BigInt(((m[2] ?? "") + "00").slice(0, 2));
}

const ceilDiv = (num: bigint, den: bigint): bigint => (num + den - 1n) / den;
const halfUpDiv = (num: bigint, den: bigint): bigint => (num * 2n + den) / (den * 2n);

/** Canonical numeric(19,4) from cents, matching the CA/US factor format. */
function d4(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${((abs % 100n) * 100n).toString().padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Year resolution: 2026 only, everything else throws by name
// ---------------------------------------------------------------------------

/** Resolve the transcribed rates for a tax year; anything else is refused by name. */
export function nlRatesForTaxYear(year: number): 2026 {
  if (!(NL_TRANSCRIBED_YEARS_2026 as readonly number[]).includes(year)) {
    throw new PayrollError(
      `the NL payroll pack has no transcribed loonheffing tables for ${year} — 2026 is transcribed `
      + "(Rekenvoorschriften januari 2026 v2); no other year is",
    );
  }
  return 2026;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface NlStatutoryInput {
  /** Loon voor de loonheffing per loontijdvak (tvl, kolom 14 van de loonstaat). */
  income: string;
  /** Periods per year: only published tijdvakfactoren (4/12/13/52/260). */
  periodsPerYear: number;
  /** Whether the employee's signed opgaaf applies the loonheffingskorting here. */
  applyKorting: boolean;
  /** AOW age class; default is jonger dan de AOW-leeftijd. */
  ageClass?: NlAgeClass;
  /** Premieloon werknemersverzekeringen/Zvw per period; defaults to income. */
  svWage?: string | null;
  /** Declared cumulative SV wage this year (for the € 79.409 annual maximum). */
  svWageYtd?: string | null;
  /** AWf contract-type declaration: true prices the lage premie. Required when SV base > 0. */
  awfLow?: boolean | null;
  /** Aof employer-size declaration: true prices the hoge premie. Required when SV base > 0. */
  aofHigh?: boolean | null;
  /** Whk beschikking percentage. Required when SV base > 0 — never a constant. */
  whkPercent?: string | null;
  /** Alleenstaande-ouderenkorting elected (AOW only). */
  aokApply?: boolean;
  /** Jonggehandicaptenkorting applies (€ 923, AOW+ herleid € 462). */
  jgkApply?: boolean;
  /** Non-periodic (bonus) pay: always refused — the bijzondere tarieven are not transcribed. */
  nonPeriodic?: string | null;
}

export interface NlStatutoryResult {
  /** Jaarloon L in whole euros (multiple of € 54 at or below Lmax). */
  annualWage: number;
  /** X1: schijventarief amount before kortingen, whole euros. */
  grossAnnual: number;
  applied: { ahk: number; ouk: number; ark: number; aok: number };
  /** X: annual withholding, whole euros. */
  netAnnual: number;
  /** x: per-period loonheffing before JGK, cents. */
  periodicCents: bigint;
  /** ark: verrekende arbeidskorting per period, cents. */
  arkPeriodicCents: bigint;
  /** ahk/ouk/aok per-period underlays, cents. */
  ahkPeriodicCents: bigint;
  oukPeriodicCents: bigint;
  aokPeriodicCents: bigint;
  /** Tabelloon ℓ = L/F rounded up to cents (matches the witte tabellen column). */
  tableWageCents: bigint;
  /** JGK time-slice reduction applied, cents (0 when not elected). */
  jgkReductionCents: bigint;
  /** Final per-period loonheffing, cents. */
  withholdingCents: bigint;
  /** Above-Lmax top-up xboven, cents (0 at or below Lmax). */
  aboveMaxCents: bigint;
  /** SV premium base after period and annual maxima, cents. */
  svBaseCents: bigint;
  wwCents: bigint;
  aofCents: bigint;
  whkCents: bigint;
  zvwCents: bigint;
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

const AGE_CLASSES: readonly string[] = ["under_aow", "aow_1945", "aow_1946"];

function ahkAnnual(L: number, aow: boolean): number {
  const p = aow ? NL_AHK_2026.aow : NL_AHK_2026.under_aow;
  if (L <= p.phaseFrom) return p.base;
  if (L > p.phaseTo) return 0;
  // "AHK = ahkm1 - (L - ahkg1) * ahka1, waarbij u AHK (jaarbedrag) naar
  // boven afrondt op hele euro's" and "AHK niet kleiner is dan € 0".
  const remainder5 = BigInt(p.base) * 100000n - BigInt(L - p.phaseFrom) * parseRate5(p.phaseOut, "AHK afbouwfactor");
  const capped = remainder5 < 0n ? 0n : remainder5;
  return Number(ceilDiv(capped, 100000n));
}

function oukAnnual(L: number, aow: boolean): number {
  if (!aow) return 0;
  const p = NL_OUK_2026;
  if (L <= p.phaseFrom) return p.base;
  if (L > p.phaseTo) return 0;
  // "u OUK (jaarbedrag) naar boven afrondt op hele euro's" / "niet kleiner dan € 0".
  const remainder5 = BigInt(p.base) * 100000n - BigInt(L - p.phaseFrom) * parseRate5(p.phaseOut, "OUK afbouwfactor");
  const capped = remainder5 < 0n ? 0n : remainder5;
  return Number(ceilDiv(capped, 100000n));
}

function arkAnnual(L: number, aow: boolean): number {
  const p = aow ? NL_ARK_2026.aow : NL_ARK_2026.under_aow;
  if (L > p.taperEnd) return 0;
  // "ARK = arko1 * L + arko2 * (L - arkg1) + arko3 * (L - arkg2)
  //        - arka1 * (L - arkg3)", each product "rekenkundig afrondt op
  // 5 decimalen" (exact at 5dp from whole-euro L), running sums "maximeert
  // op arkm1/arkm2/arkm3", "u ARK (jaarbedrag) naar boven afrondt op hele euro's".
  const over1 = Math.max(L - p.band1, 0);
  const over2 = Math.max(L - p.band2, 0);
  const over3 = Math.max(L - p.band3, 0);
  const t1 = BigInt(L) * parseRate5(p.build1, "ARK opbouwfactor 1");
  const capped1 = t1 > BigInt(p.max1) * 100000n ? BigInt(p.max1) * 100000n : t1;
  const s2 = capped1 + BigInt(over1) * parseRate5(p.build2, "ARK opbouwfactor 2");
  const capped2 = s2 > BigInt(p.max2) * 100000n ? BigInt(p.max2) * 100000n : s2;
  const s3 = capped2 + BigInt(over2) * parseRate5(p.build3, "ARK opbouwfactor 3");
  const capped3 = s3 > BigInt(p.max3) * 100000n ? BigInt(p.max3) * 100000n : s3;
  const tapered = capped3 - BigInt(over3) * parseRate5(p.taper, "ARK afbouwfactor");
  return Number(ceilDiv(tapered < 0n ? 0n : tapered, 100000n));
}

function x1Annual(L: number, ageClass: NlAgeClass): number {
  const bands = NL_BRACKETS_2026[ageClass];
  let lower = 0;
  for (const band of bands) {
    if (band.upTo === null || L <= band.upTo) {
      // "X1 = (L - a) * b / 100 + c, waarbij u X1 naar beneden afrondt op hele euro's".
      const rate100 = parseRate2(band.ratePct, "schijventarief");
      return Number((BigInt(L - lower) * rate100) / 10000n) + band.cumulative;
    }
    lower = band.upTo;
  }
  throw new PayrollError("the NL payroll pack cannot price the schijventarief: no top band");
}

/** Price one annual withholding at or below Lmax (L whole euros, multiple of € 54). */
function priceAnnual(L: number, ageClass: NlAgeClass, applyKorting: boolean, aokApply: boolean): {
  x1: number; ahk: number; ouk: number; ark: number; aok: number; x: number;
} {
  const x1 = x1Annual(L, ageClass);
  const aow = ageClass !== "under_aow";
  let ahk = 0;
  let ouk = 0;
  let ark = 0;
  let aok = 0;
  if (applyKorting) {
    ahk = ahkAnnual(L, aow);
    ouk = oukAnnual(L, aow);
    ark = arkAnnual(L, aow);
    if (aokApply) aok = NL_AOK_2026;
  }
  // "X = X1 - (AHK + OUK + ARK + AOK)", "u X naar beneden afrondt op hele
  // euro's als L ≤ Lmax", "anders X = € 0 (nul), en topt u het theoretische
  // bedrag van de heffingskortingen af in volgorde AOK, ARK, OUK, AHK": the
  // named order is the reduction order, so AHK is kept first and AOK last —
  // the witte maandtabel pins this (tabelloon € 729: verrekende ARK € 1,00,
  // only the AHK-first keep leaves ARK € 12).
  let x = x1 - (ahk + ouk + ark + aok);
  if (x < 0) {
    x = 0;
    let room = x1;
    ahk = Math.min(ahk, room);
    room -= ahk;
    ouk = Math.min(ouk, room);
    room -= ouk;
    ark = Math.min(ark, room);
    room -= ark;
    aok = Math.min(aok, room);
  }
  return { x1, ahk, ouk, ark, aok, x };
}

export function calculateNlStatutory(input: NlStatutoryInput): NlStatutoryResult {
  const ageClass = input.ageClass ?? "under_aow";
  if (!AGE_CLASSES.includes(ageClass)) {
    throw new PayrollError(
      `the NL payroll pack cannot price age class "${input.ageClass}" — declare "under_aow", "aow_1945" or "aow_1946"`,
    );
  }
  const F = NL_PERIOD_FACTORS_2026[input.periodsPerYear];
  if (F === undefined) {
    throw new PayrollError(
      `the NL payroll pack cannot price ${input.periodsPerYear} periods per year — the Rekenvoorschriften `
      + "publish tijdvakfactoren only for kwartaal (4), maand (12), vierweken (13), week (52) and dag (260)",
    );
  }
  if (input.aokApply === true && ageClass === "under_aow") {
    throw new PayrollError(
      "the NL payroll pack cannot apply the alleenstaande-ouderenkorting below the AOW age — "
      + "Rekenvoorschriften Tabel 5 gives it as \"niet van toepassing\" for jonger dan de AOW-leeftijd",
    );
  }
  const nonPeriodic = input.nonPeriodic ?? "0";
  if (parseCents(nonPeriodic, "non-periodic pay") > 0n) {
    throw new PayrollError(
      `the NL payroll pack refuses non-periodic pay of € ${nonPeriodic} by name — the tabel voor bijzondere `
      + "beloningen is not transcribed (its row-selection rule, Handboek Loonheffingen 2026 §9.3.6, was not "
      + "obtainable from the Belastingdienst), and pricing a bonus through the regular table over-withholds",
    );
  }

  const tvlCents = parseCents(input.income, "period wage");
  const aow = ageClass !== "under_aow";

  // L: "als tvl * F ≤ 0 dan L = € 0"; at or below Lmax floor to a multiple
  // of Lv (€ 54); above Lmax systematiek 1.
  const scaledCents = tvlCents * BigInt(F);
  const lmaxCents = BigInt(NL_LMAX_2026) * 100n;
  const aboveMax = scaledCents > lmaxCents;

  if (!aboveMax) {
    // "L = {(tvl * F) / Lv} * Lv, waarbij u (tvl * F) / Lv naar beneden afrondt op 0 decimalen".
    const L = Number(scaledCents / BigInt(NL_LV_2026 * 100)) * NL_LV_2026;
    const priced = priceAnnual(L, ageClass, input.applyKorting, input.aokApply === true);
    const periodicCents = halfUpDiv(BigInt(priced.x) * 100n, BigInt(F));
    return finishCalculation({
      input, F, aow, annualWage: L, priced, periodicCents,
      aboveMaxCents: 0n, aboveMax: false,
    });
  }
  // Above Lmax there is no tabelloon: systematiek 1 prices the period wage
  // directly ("x = y + xboven").
  const atMax = priceAnnual(NL_LMAX_2026, ageClass, input.applyKorting, input.aokApply === true);
  const yCents = halfUpDiv(BigInt(atMax.x) * 100n, BigInt(F));
  // "xboven = (L / F - Lmax / F) * (bmax / 100)", "u xboven naar beneden afrondt op 2 decimalen".
  const topRate = parseRate2(NL_BRACKETS_2026[ageClass][2]!.ratePct, "hoogste schijf");
  const aboveMaxCents = ((scaledCents - lmaxCents) * topRate) / (10000n * BigInt(F));
  return finishCalculation({
    input, F, aow, annualWage: null, priced: atMax, periodicCents: yCents + aboveMaxCents,
    aboveMaxCents, aboveMax: true,
  });
}

function finishCalculation(args: {
  input: NlStatutoryInput;
  F: number;
  aow: boolean;
  /** Null above Lmax (no tabelloon there). */
  annualWage: number | null;
  priced: { x1: number; ahk: number; ouk: number; ark: number; aok: number; x: number };
  periodicCents: bigint;
  aboveMaxCents: bigint;
  aboveMax: boolean;
}): NlStatutoryResult {
  const { input, F, priced, periodicCents, aboveMaxCents, aboveMax } = args;
  const bigF = BigInt(F);

  const arkPeriodicCents = halfUpDiv(BigInt(priced.ark) * 100n, bigF);
  const ahkPeriodicCents = halfUpDiv(BigInt(priced.ahk) * 100n, bigF);
  const oukPeriodicCents = halfUpDiv(BigInt(priced.ouk) * 100n, bigF);
  const aokPeriodicCents = halfUpDiv(BigInt(priced.aok) * 100n, bigF);

  // Tabelloon ℓ = L/F "naar boven op 2 decimalen" (Tabel 8); above Lmax the
  // period wage itself is the tabelloon.
  const tableWageCents = args.annualWage === null
    ? parseCents(input.income, "period wage")
    : ceilDiv(BigInt(args.annualWage) * 100n, bigF);

  // Jonggehandicaptenkorting: "het tijdvakbedrag van deze korting in
  // mindering brengen op het bedrag dat u volgens de loonbelastingtijdvaktabel
  // moet inhouden, maar niet verder dan tot € 0" (§5); the slice is
  // "het jaarbedrag ... delen door F en rekenkundig afronden op 2 decimalen".
  let jgkReductionCents = 0n;
  if (input.jgkApply === true) {
    const annual = args.aow ? NL_JGK_2026_AOW : NL_JGK_2026;
    const slice = halfUpDiv(BigInt(annual) * 100n, bigF);
    jgkReductionCents = slice > periodicCents ? periodicCents : slice;
  }
  const withholdingCents = periodicCents - jgkReductionCents;

  // Employer premiums on the SV-loon, capped per period (Tabel 11) and per
  // year (€ 79.409): "Loontijdvakmaxima zijn gelijk voor de
  // werknemersverzekeringen en de Zorgverzekeringswet".
  const svWageRaw = input.svWage ?? null;
  const svEarn = svWageRaw === null || svWageRaw.trim() === ""
    ? parseCents(input.income, "period wage")
    : parseCents(svWageRaw, "SV wage");
  const ytdRaw = input.svWageYtd ?? "0";
  const ytd = parseCents(ytdRaw, "declared SV year-to-date");
  const periodMax = parseCents(NL_MAX_PREMIUM_WAGE_2026[F]!, "maximumpremieloon");
  const annualMax = parseCents(NL_MAX_PREMIUM_WAGE_ANNUAL_2026, "maximumpremieloon");
  const headroom = annualMax > ytd ? annualMax - ytd : 0n;
  let svBase = svEarn;
  if (svBase > periodMax) svBase = periodMax;
  if (svBase > headroom) svBase = headroom;

  let wwCents = 0n;
  let aofCents = 0n;
  let whkCents = 0n;
  if (svBase > 0n) {
    if (input.awfLow === null || input.awfLow === undefined) {
      throw new PayrollError(
        "the NL payroll pack cannot price the WW (AWf) premium without the contract-type declaration — "
        + "declare awfLow (lage premie 2,74% for a qualifying vast contract, else hoge premie 7,74%)",
      );
    }
    if (input.aofHigh === null || input.aofHigh === undefined) {
      throw new PayrollError(
        "the NL payroll pack cannot price the WIA (Aof) premium without the employer-size declaration — "
        + "declare aofHigh (hoge premie 7,63% for a large employer, else lage premie 6,27%)",
      );
    }
    if (input.whkPercent === null || input.whkPercent === undefined || input.whkPercent.trim() === "") {
      throw new PayrollError(
        "the NL payroll pack cannot price the Whk premium without the beschikking percentage — "
        + "the Belastingdienst sets it per employer (\"Zie mededeling of beschikking\"), so declare whkPercent",
      );
    }
    const awfRate = parseRate2(input.awfLow ? NL_EMPLOYER_PREMIUMS_2026.awfLow : NL_EMPLOYER_PREMIUMS_2026.awfHigh, "AWf");
    const aofRate = parseRate2(input.aofHigh ? NL_EMPLOYER_PREMIUMS_2026.aofHigh : NL_EMPLOYER_PREMIUMS_2026.aofLow, "Aof");
    const whkRate = parseRate2(input.whkPercent, "Whk beschikking");
    if (whkRate > 10000n) {
      throw new PayrollError(
        `the NL payroll pack cannot price a Whk beschikking of "${input.whkPercent}" — a premium percentage above 100%`,
      );
    }
    // No per-step rounding is published for employer premiums in the 2026
    // Tarieven newsletter or the Rekenvoorschriften; applied arithmetically
    // to the cent and stated as such.
    wwCents = halfUpDiv(svBase * awfRate, 10000n);
    aofCents = halfUpDiv(svBase * aofRate, 10000n);
    whkCents = halfUpDiv(svBase * whkRate, 10000n);
  }
  const zvwRate = parseRate2(NL_ZVW_2026.employer, "werkgeversheffing Zvw");
  const zvwCents = halfUpDiv(svBase * zvwRate, 10000n);

  return {
    annualWage: args.annualWage ?? -1,
    grossAnnual: priced.x1,
    applied: { ahk: priced.ahk, ouk: priced.ouk, ark: priced.ark, aok: priced.aok },
    netAnnual: aboveMax ? -1 : priced.x,
    periodicCents,
    arkPeriodicCents,
    ahkPeriodicCents,
    oukPeriodicCents,
    aokPeriodicCents,
    tableWageCents,
    jgkReductionCents,
    withholdingCents,
    aboveMaxCents,
    svBaseCents: svBase,
    wwCents,
    aofCents,
    whkCents,
    zvwCents,
  };
}

// ---------------------------------------------------------------------------
// Phase 9 wiring: pack computeStatutory
// ---------------------------------------------------------------------------

/**
 * Phase 9 — NL pack statutory pass (Rekenvoorschriften 2026).
 *
 * Every per-employee input arrives through the pack's own declared
 * certificates (`./certificates.ts`), read with the generic typed readers —
 * the same channel the DE ELStAM and FR PAS answers travel. Nothing is read
 * off `employee_payroll_profiles` columns: no column carries an NL fact, so
 * this wiring needs no profile migration, no API branch and no UI edit that
 * names the country:
 *
 * - `nl_loonheffingen` (the opgaaf): `apply_loonheffingskorting` (absent form
 *   means not applied), `age_class` ("under_aow" default, "aow_1945" or
 *   "aow_1946"), `aok_apply` / `jgk_apply` (elected kortingen);
 * - `nl_premies` (the employer's SV administration): `awf_laag` /
 *   `aof_hoog` (no defaults — required when the SV base prices above zero),
 *   `whk_percent` (the beschikking percentage, no lawful default — required
 *   when the SV base prices above zero), `sv_loon_ytd` (declared cumulative
 *   SV wage, default 0).
 *
 * The SV-loon (`insurable`) defaults to the loonheffing wage when the
 * pipeline supplies none; stated here, not guessed per employee.
 */
/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. Single letters are the Belastingdienst
 * Rekenvoorschriften's own (L tabel-loon, X netto, AHK/ARK/OUK/AOK/JGK the
 * heffingskortingen) — see the module header.
 */
export const NL_FACTOR_LABELS: Readonly<Record<string, string>> = {
  L: "Table wage, annual (Rekenvoorschriften L)",
  X1: "Gross annual wage",
  AHK: "Algemene heffingskorting applied",
  ARK: "Arbeidskorting applied",
  OUK: "Ouderenkorting applied",
  AOK: "Alleenstaande-ouderenkorting applied",
  X: "Net annual (Rekenvoorschriften X)",
  LH: "Loonheffing this period",
  ARK_T: "Arbeidskorting this period",
  AHK_T: "Algemene heffingskorting this period",
  JGK: "Jonggehandicaptenkorting reduction",
  SV_BASE: "SV-loon base",
  WW: "AWf premium (employer)",
  AOF: "Aof basispremie (employer)",
  WHK: "Whk premium (employer)",
  ZW: "ZW premium",
  ZVW: "Werkgeversheffing Zvw (employer)",
  I: "Periodic income this period",
  IE: "Insurable earnings (SV-loon) this period",
  B: "Bonus / non-periodic pay this period",
};

export async function computeNlStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const { region, taxYear, periodsPerYear: P, income, nonPeriodic, insurable, pushStatutory, assertRegionSupported, certificateFor } = ctx;
  assertRegionSupported(region);
  nlRatesForTaxYear(taxYear);

  const opgaaf = certificateFor("nl_loonheffingen");
  const applyKorting = opgaaf === null ? false : certificateFlag(opgaaf, "apply_loonheffingskorting");
  const ageClass: NlAgeClass = opgaaf === null
    ? "under_aow"
    : (certificateChoice(opgaaf, "age_class") ?? "under_aow") as NlAgeClass;
  const aokApply = opgaaf === null ? false : certificateFlag(opgaaf, "aok_apply");
  const jgkApply = opgaaf === null ? false : certificateFlag(opgaaf, "jgk_apply");

  const premies = certificateFor("nl_premies");
  // A flag answer is only meaningful when actually answered: the SV legs
  // below distinguish "hoge premie" (false) from "undeclared" (null, refused
  // when the base prices). The typed reader cannot see that difference, so
  // presence is read off the resolved answers first.
  const flagOrNull = (resolved: ResolvedCertificate | null, key: string): boolean | null => {
    const raw = resolved?.answers[key] ?? null;
    if (raw === null || raw === "") return null;
    if (resolved === null) return null;
    return certificateFlag(resolved, key);
  };
  const whkRaw = premies?.answers["whk_percent"] ?? null;
  const ytdRaw = premies?.answers["sv_loon_ytd"] ?? null;

  const result = calculateNlStatutory({
    income,
    periodsPerYear: P,
    applyKorting,
    ageClass,
    svWage: insurable === "" ? null : insurable,
    svWageYtd: ytdRaw === null || ytdRaw === ""
      ? null
      : premies === null ? null : certificateAmount(premies, "sv_loon_ytd"),
    awfLow: flagOrNull(premies, "awf_laag"),
    aofHigh: flagOrNull(premies, "aof_hoog"),
    whkPercent: whkRaw === null || whkRaw === ""
      ? null
      : premies === null ? null : certificateAmount(premies, "whk_percent"),
    aokApply,
    jgkApply,
    nonPeriodic,
  });

  pushStatutory("loonheffing", "deduction", "Loonbelasting/premie volksverzekeringen", d4(result.withholdingCents), 110);
  pushStatutory("ww", "employer_contribution", "Werkloosheidswet (AWf)", d4(result.wwCents), 210);
  // The Aof basispremie and the differentiated Whk beschikking are both
  // WIA-side employer premiums; the beschikking quotes one percentage, so
  // the Whk amount rides the WIA line (see rates.ts: no ZW row exists).
  pushStatutory("wia", "employer_contribution", "Arbeidsongeschiktheid (Aof + Whk)", d4(result.aofCents + result.whkCents), 211);
  pushStatutory("zvw", "employer_contribution", "Werkgeversheffing Zorgverzekeringswet", d4(result.zvwCents), 230);

  return {
    L: result.annualWage < 0 ? "above_max" : `${result.annualWage}.0000`,
    X1: `${result.grossAnnual}.0000`,
    AHK: `${result.applied.ahk}.0000`,
    ARK: `${result.applied.ark}.0000`,
    OUK: `${result.applied.ouk}.0000`,
    AOK: `${result.applied.aok}.0000`,
    X: result.netAnnual < 0 ? "above_max" : `${result.netAnnual}.0000`,
    LH: d4(result.withholdingCents),
    ARK_T: d4(result.arkPeriodicCents),
    AHK_T: d4(result.ahkPeriodicCents),
    JGK: d4(result.jgkReductionCents),
    SV_BASE: d4(result.svBaseCents),
    WW: d4(result.wwCents),
    AOF: d4(result.aofCents),
    WHK: d4(result.whkCents),
    ZW: d4(0n),
    ZVW: d4(result.zvwCents),
    I: income,
    IE: insurable,
    B: nonPeriodic,
  };
}
