/**
 * The PL pack's statutory pass: monthly PIT advances (zaliczki) and ZUS/NFZ
 * contributions for calendar years 2024–2026.
 *
 * The three years share one engine (`calculatePlZusWithTables` /
 * `calculatePlPitWithTables`): the PIT scale, ZUS rates and fund rates are
 * identical across all three, so each year's module carries only its own
 * constants and the computation reads them through `PlYearTables`. What
 * DIFFERS by year is carried as data, never as branches:
 * - the emerytalne/rentowe annual base limit (234 720 / 260 190 / 282 600);
 * - the minimum wage — including 2024's two steps (4 242 zł to June,
 *   4 300 zł from July), resolved from the pay date;
 * - the FP/FS age-bar citation (promotion-act art. 104b ust. 2 for 2024,
 *   art. 104b ust. 2 / labour-market art. 261 for 2025, art. 261 for 2026);
 * - `fgspAgeBar`: the claims-protection act (art. 9b ust. 2) exempts women
 *   55+ / men 60+ from FGŚP, which 2024 and 2025 model by zeroing FGŚP
 *   above 60-by-year. 2026 keeps its landed behaviour of pricing FGŚP
 *   unconditionally — that contradiction is reported, not changed here,
 *   and the flag keeps 2026 byte-identical.
 *
 * Method (agency-stated, quoted from the statutes transcribed in
 * ./tables-2026.ts):
 *
 * - PIT dochód: monthly revenue minus KUP (art. 22 ust. 2 pkt 1: 250 zł;
 *   pkt 3: 300 zł dojazd — the certificate states which) minus the
 *   employee's social contributions withheld that month (art. 32 ust. 4),
 *   rounded to whole złotych (Ordynacja art. 63 § 1).
 * - Advance: 12 % while the employee's year-to-date dochód from this payer
 *   stays at or under 120 000 zł, the 12 %/32 % split in the crossing
 *   month, 32 % after (art. 32 ust. 2), minus the oświadczenie reduction
 *   (art. 31b ust. 1: 1/12/1/24/1/36 of 3 600), rounded to whole złotych
 *   (Ordynacja art. 63 § 1) and floored at zero ("nie więcej niż" caps the
 *   reduction at the advance itself).
 * - Year-to-date under level pay: no pack channel carries YTD, so the
 *   engine annualises the month's figure at monthly periodicity — prior
 *   months = (month − 1) × this month — exact for level pay, refused by
 *   name for uneven paths (see PL_REFUSALS_2026). The calendar month comes
 *   from the run's pay_date.
 * - ZUS base: the month's revenue, emerytalne/rentowe capped at the
 *   remaining 282 600 zł room (art. 19 ust. 1 and 3 — "Od nadwyżki …
 *   nie pobiera się składek na ubezpieczenia emerytalne i rentowe"),
 *   same level-pay annualisation. Chorobowe, zdrowotna and the fundusz
 *   lines price the full revenue: the cap covers emerytalne/rentowe only,
 *   and art. 81 ust. 5 explicitly exempts zdrowotna from it.
 * - Zdrowotna base: revenue minus the employee's emerytalne/rentowe/
 *   chorobowe (art. 81 ust. 6), rated 9 % (art. 79 ust. 1).
 * - FP/FS: uncapped base at or above the 4 806 zł minimum wage
 *   (art. 259 ust. 1), 1,0 % / 1,45 % (Budget Act arts. 25–26). FGŚP 0,10 %
 *   on the same uncapped base with no wage threshold (art. 29 ust. 1 of the
 *   claims-protection act + Budget Act art. 27).
 * - FP/FS age bar (art. 261: 55 women / 60 men): the pack carries birth
 *   years, not birth months or sex, so the engine applies below
 *   55-by-year, zeroes above 60-by-year, and refuses the 55–60 band by
 *   name — year granularity cannot tell which month the exemption starts.
 * - Ulga dla młodych: anyone turning 26 or less in the tax year is refused
 *   by name (the under-26 exemption needs its claim channel plus YTD).
 * - Wypadkowe: priced by the pure function when a tenant rate is declared,
 *   but the adapter passes none — no pack channel carries the payer's
 *   PKD/ZUS rate — so the line is not pushed (FR AT/MP precedent).
 *
 * What this pass does NOT do (named refusals, stated): non-monthly
 * periodicity, uneven-pay threshold crossings, the FP age band, PUP-hire
 * and return-from-leave FP exemptions, ulga dla młodych, 50 % KUP,
 * joint filing, PPK, non-employment titles, zero-advance requests and
 * multi-payer pomniejszenia (see PL_REFUSALS_2026).
 *
 * Money: bigint units (1e4) throughout via the repo's money.ts, halves
 * away from zero (roundDiv). PIT lines round half-up to the złoty
 * (Ordynacja art. 63 § 1: <50 gr dropped, ≥50 gr up); ZUS/NFZ lines round
 * half-up to the grosz (engine-stated — no quotable agency rule, per the
 * FR precedent). Never floating point.
 */
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { empFact } from "../employee-facts.ts";
// Side effect: registers PL_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import {
  PL_FUNDUSZE_2024,
  PL_KUP_2024,
  PL_MIN_WAGE_2024,
  PL_PIT_POMNIEJSZENIE_2024,
  PL_PIT_SKALA_2024,
  PL_ROCZNY_LIMIT_2024,
  PL_SKLADKI_PODZIAL_2024,
  PL_ZDROWOTNA_2024,
} from "./tables-2024.ts";
import {
  PL_FUNDUSZE_2025,
  PL_KUP_2025,
  PL_MIN_WAGE_2025,
  PL_PIT_POMNIEJSZENIE_2025,
  PL_PIT_SKALA_2025,
  PL_ROCZNY_LIMIT_2025,
  PL_SKLADKI_PODZIAL_2025,
  PL_ZDROWOTNA_2025,
} from "./tables-2025.ts";
import {
  PL_FUNDUSZE_2026,
  PL_KUP_2026,
  PL_MIN_WAGE_2026,
  PL_PIT_POMNIEJSZENIE_2026,
  PL_PIT_SKALA_2026,
  PL_ROCZNY_LIMIT_2026,
  PL_SKLADKI_PODZIAL_2026,
  PL_ZDROWOTNA_2026,
  plTableYearForPayDate,
} from "./tables-2026.ts";

/**
 * One transcribed year's tables, in the single shape the shared engine
 * reads. Each year module conforms to it: a new edition adds a module plus
 * one `PL_<year>_TABLES` entry, never a branch in the computation.
 *
 * Rates are exact decimal fraction strings, amounts whole złotych — the
 * same money discipline as the year modules.
 */
export interface PlYearTables {
  readonly year: number;
  /** Year module path, named in refusals (mirrors `ratesModule`). */
  readonly module: string;
  /** Refusal-list const name quoted in refusal messages. */
  readonly refusedListName: string;
  /** Statute citation for the FP/FS 55–60 sex-split bar. */
  readonly fpAgeCite: string;
  readonly prog: string;
  readonly stawkaDolna: string;
  readonly stawkaGorna: string;
  readonly kupMiejscowy: string;
  readonly kupDojazd: string;
  readonly pomnPelne: string;
  readonly pomnPolowa: string;
  readonly pomnTrzecia: string;
  readonly emerytalneEe: string;
  readonly emerytalneEr: string;
  readonly rentoweEe: string;
  readonly rentoweEr: string;
  readonly choroboweEe: string;
  readonly zdrowotna: string;
  readonly limitAnnual: string;
  readonly fp: string;
  readonly fs: string;
  readonly fgsp: string;
  /** Minimum wage pricing FP/FS eligibility for the month. */
  readonly minWage: string;
  /** Second-half minimum wage for a mid-year step (2024 only). */
  readonly minWageJul?: string | undefined;
  /** First pay date the second-half wage applies to (2024: 2024-07-01). */
  readonly minWageSwitch?: string | undefined;
  /**
   * Whether the FGŚP 55/60 age bar (claims-protection art. 9b ust. 2) is
   * modelled. True for 2024/2025; false for 2026, which keeps its landed
   * unconditional pricing (reported, not changed — see the module header).
   */
  readonly fgspAgeBar: boolean;
}

/** 2026 tables, built from the landed 2026 constants — behaviour unchanged. */
export const PL_2026_TABLES: PlYearTables = {
  year: 2026,
  module: "engine/src/payroll/pl/tables-2026.ts",
  refusedListName: "PL_REFUSALS_2026",
  fpAgeCite: "art. 261",
  prog: PL_PIT_SKALA_2026.prog,
  stawkaDolna: PL_PIT_SKALA_2026.stawkaDolna.rate,
  stawkaGorna: PL_PIT_SKALA_2026.stawkaGorna.rate,
  kupMiejscowy: PL_KUP_2026.miejscowy.miesiecznie,
  kupDojazd: PL_KUP_2026.dojazd.miesiecznie,
  pomnPelne: PL_PIT_POMNIEJSZENIE_2026.pelne,
  pomnPolowa: PL_PIT_POMNIEJSZENIE_2026.polowa,
  pomnTrzecia: PL_PIT_POMNIEJSZENIE_2026.trzecia,
  emerytalneEe: PL_SKLADKI_PODZIAL_2026.emerytalneEe.rate,
  emerytalneEr: PL_SKLADKI_PODZIAL_2026.emerytalneEr.rate,
  rentoweEe: PL_SKLADKI_PODZIAL_2026.rentoweEe.rate,
  rentoweEr: PL_SKLADKI_PODZIAL_2026.rentoweEr.rate,
  choroboweEe: PL_SKLADKI_PODZIAL_2026.choroboweEe.rate,
  zdrowotna: PL_ZDROWOTNA_2026.rate,
  limitAnnual: PL_ROCZNY_LIMIT_2026.annual,
  fp: PL_FUNDUSZE_2026.fp.rate,
  fs: PL_FUNDUSZE_2026.fs.rate,
  fgsp: PL_FUNDUSZE_2026.fgsp.rate,
  minWage: PL_MIN_WAGE_2026.monthly,
  fgspAgeBar: false,
};

/** 2025 tables, built from ./tables-2025.ts. */
export const PL_2025_TABLES: PlYearTables = {
  year: 2025,
  module: "engine/src/payroll/pl/tables-2025.ts",
  refusedListName: "PL_REFUSALS_2025",
  fpAgeCite: "art. 104b ust. 2 / art. 261",
  prog: PL_PIT_SKALA_2025.prog,
  stawkaDolna: PL_PIT_SKALA_2025.stawkaDolna.rate,
  stawkaGorna: PL_PIT_SKALA_2025.stawkaGorna.rate,
  kupMiejscowy: PL_KUP_2025.miejscowy.miesiecznie,
  kupDojazd: PL_KUP_2025.dojazd.miesiecznie,
  pomnPelne: PL_PIT_POMNIEJSZENIE_2025.pelne,
  pomnPolowa: PL_PIT_POMNIEJSZENIE_2025.polowa,
  pomnTrzecia: PL_PIT_POMNIEJSZENIE_2025.trzecia,
  emerytalneEe: PL_SKLADKI_PODZIAL_2025.emerytalneEe.rate,
  emerytalneEr: PL_SKLADKI_PODZIAL_2025.emerytalneEr.rate,
  rentoweEe: PL_SKLADKI_PODZIAL_2025.rentoweEe.rate,
  rentoweEr: PL_SKLADKI_PODZIAL_2025.rentoweEr.rate,
  choroboweEe: PL_SKLADKI_PODZIAL_2025.choroboweEe.rate,
  zdrowotna: PL_ZDROWOTNA_2025.rate,
  limitAnnual: PL_ROCZNY_LIMIT_2025.annual,
  fp: PL_FUNDUSZE_2025.fp.rate,
  fs: PL_FUNDUSZE_2025.fs.rate,
  fgsp: PL_FUNDUSZE_2025.fgsp.rate,
  minWage: PL_MIN_WAGE_2025.monthly,
  fgspAgeBar: true,
};

/** 2024 tables, built from ./tables-2024.ts. */
export const PL_2024_TABLES: PlYearTables = {
  year: 2024,
  module: "engine/src/payroll/pl/tables-2024.ts",
  refusedListName: "PL_REFUSALS_2024",
  fpAgeCite: "art. 104b ust. 2",
  prog: PL_PIT_SKALA_2024.prog,
  stawkaDolna: PL_PIT_SKALA_2024.stawkaDolna.rate,
  stawkaGorna: PL_PIT_SKALA_2024.stawkaGorna.rate,
  kupMiejscowy: PL_KUP_2024.miejscowy.miesiecznie,
  kupDojazd: PL_KUP_2024.dojazd.miesiecznie,
  pomnPelne: PL_PIT_POMNIEJSZENIE_2024.pelne,
  pomnPolowa: PL_PIT_POMNIEJSZENIE_2024.polowa,
  pomnTrzecia: PL_PIT_POMNIEJSZENIE_2024.trzecia,
  emerytalneEe: PL_SKLADKI_PODZIAL_2024.emerytalneEe.rate,
  emerytalneEr: PL_SKLADKI_PODZIAL_2024.emerytalneEr.rate,
  rentoweEe: PL_SKLADKI_PODZIAL_2024.rentoweEe.rate,
  rentoweEr: PL_SKLADKI_PODZIAL_2024.rentoweEr.rate,
  choroboweEe: PL_SKLADKI_PODZIAL_2024.choroboweEe.rate,
  zdrowotna: PL_ZDROWOTNA_2024.rate,
  limitAnnual: PL_ROCZNY_LIMIT_2024.annual,
  fp: PL_FUNDUSZE_2024.fp.rate,
  fs: PL_FUNDUSZE_2024.fs.rate,
  fgsp: PL_FUNDUSZE_2024.fgsp.rate,
  minWage: PL_MIN_WAGE_2024.pierwszaPolowa,
  minWageJul: PL_MIN_WAGE_2024.drugaPolowa,
  minWageSwitch: PL_MIN_WAGE_2024.zmianaOd,
  fgspAgeBar: true,
};

/** Resolve the year's tables by calendar year, refusing anything else. */
function tablesForYear(year: number): PlYearTables {
  if (year === 2026) return PL_2026_TABLES;
  if (year === 2025) return PL_2025_TABLES;
  if (year === 2024) return PL_2024_TABLES;
  throw new PayrollPackError(
    `PL withholding for tax year ${year} has not been transcribed `
    + "— the PL payroll pack's transcribed years are calendar 2024–2026 "
    + "(see engine/src/payroll/pl/tables-2024.ts, tables-2025.ts and tables-2026.ts). "
    + "Transcribe the year's tables before calculating",
  );
}

const U = (s: string): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);

const RATE6 = 1_000_000n;
const GROSZ_UNITS = 100n;
const ZLOTY_UNITS = 10_000n;

/** Exact 1e6-scale rate from a table fraction string ("0.0976"). */
function rate6(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new PayrollPackError(`PL rate is not a plain decimal: "${value}"`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * RATE6 + BigInt((fraction + "000000").slice(0, 6));
}

/** Round units half-up to the grosz. */
function rGrosz(u: bigint): bigint {
  return roundDiv(u, GROSZ_UNITS) * GROSZ_UNITS;
}

/** Round units half-up to the whole złoty (Ordynacja art. 63 § 1). */
function rZloty(u: bigint): bigint {
  return roundDiv(u, ZLOTY_UNITS) * ZLOTY_UNITS;
}

/** rate (1e6 fraction scale) × base units, half-up to the grosz. */
function lineOf(baseUnits: bigint, rate: bigint): bigint {
  return rGrosz(roundDiv(baseUnits * rate, RATE6));
}

/** Polish thousands grouping for whole-złotych displays ("282600" → "282 600"). */
function groupPl(amount: string): string {
  return amount.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Calendar month (1–12) of an ISO pay date already gated to its year. */
function monthOf(payDate: string): number {
  const month = Number(payDate.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new PayrollPackError(
      `PL pay date has no calendar month 01–12: "${payDate}"`,
    );
  }
  return month;
}

function requireMonthly(periodsPerYear: number, tables: PlYearTables): void {
  if (periodsPerYear !== 12) {
    throw new PayrollPackError(
      `PL ${tables.year} prices monthly pay (12 periods per year), got ${periodsPerYear}: `
      + `non-monthly periodicity is refused by name (see ${tables.refusedListName}).`,
    );
  }
}

/** Gate a pay date to the tables' own calendar year — never extrapolate. */
function requirePayYear(payDate: string, tables: PlYearTables): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    throw new PayrollPackError(
      `PL tables need an ISO pay date (YYYY-MM-DD), got "${payDate}"`,
    );
  }
  if (payDate < `${tables.year}-01-01` || payDate > `${tables.year}-12-31`) {
    throw new PayrollPackError(
      `PL tables have no transcribed figures for pay date ${payDate}: `
      + `the PL pack transcribes calendar ${tables.year} in ${tables.module} `
      + "(see the module header for the instruments). "
      + "Transcribe the year's tables into engine/src/payroll/pl/ first.",
    );
  }
}

/**
 * Minimum wage pricing FP/FS eligibility for the pay month. 2024 carries
 * two steps in one regulation (4 242 zł to June, 4 300 zł from 1 July);
 * every other transcribed year carries one.
 */
function minWageForMonth(tables: PlYearTables, payDate: string): bigint {
  if (
    tables.minWageJul !== undefined
    && tables.minWageSwitch !== undefined
    && payDate >= tables.minWageSwitch
  ) {
    return U(tables.minWageJul);
  }
  return U(tables.minWage);
}

/**
 * Year-agnostic calculator input: the shape is identical for every
 * transcribed year (the year-suffixed aliases below are historical).
 */
export interface PlZusCalcInput {
  /** Miesięczny przychód (income + nonPeriodic of the versement), decimal. */
  brut: string;
  /** Pay date, ISO YYYY-MM-DD — must fall in calendar 2026. */
  payDate: string;
  /** Usual pay periodicity; 12 = monthly, the only priced shape. */
  periodsPerYear: number;
  /** Employee's birth year (emp pl_rok_urodzenia), for the FP age bar. */
  rokUrodzenia: number;
  /** Tenant-declared wypadkowe rate as a percent ("1.67" = 1.67 %); null = undeclared. */
  wypadkowePct?: string | null;
}

/**
 * Year-agnostic calculator result: the shape is identical for every
 * transcribed year (the year-suffixed alias below is historical). The
 * annual-limit room in `podstawaSpoleczne` is the year's own limit.
 */
export interface PlZusCalcResult {
  /** Monthly emerytalne/rentowe base after the year's annual-limit room, 4dp. */
  podstawaSpoleczne: string;
  emerytEe: string;
  emerytEr: string;
  rentEe: string;
  rentEr: string;
  chorEe: string;
  /** Employee social contributions priced this month, 4dp. */
  zusEe: string;
  /** Zdrowotna base actually rated (brutto minus zusEe), 4dp. */
  podstawaZdrowotna: string;
  zdrowotna: string;
  /** Whether the FP/FS minimum-wage threshold is met. */
  fpNalezne: boolean;
  /** Whether FP/FS are age-barred (zeroed) rather than priced. */
  fpZwolnioneWiek: boolean;
  fp: string;
  fs: string;
  fgsp: string;
  /** 0.0000 unless a tenant rate was declared. */
  wypadkoweEr: string;
}

/**
 * The shared ZUS/NFZ engine: prices one month's employee and employer
 * contributions from any transcribed year's tables. Year differences are
 * data on `tables` (limit, minimum wage, `fgspAgeBar`), never branches.
 */
export function calculatePlZusWithTables(
  input: PlZusCalcInput,
  tables: PlYearTables,
): PlZusCalcResult {
  requirePayYear(input.payDate, tables);
  requireMonthly(input.periodsPerYear, tables);
  let brut: bigint;
  try {
    brut = U(input.brut);
  } catch {
    throw new PayrollPackError(`PL ZUS brut is not a decimal amount: "${input.brut}"`);
  }
  if (brut < 0n) {
    throw new PayrollPackError(`PL ZUS brut must be non-negative, got "${input.brut}"`);
  }
  const yob = input.rokUrodzenia;
  if (!Number.isInteger(yob) || yob < 1900 || yob > tables.year) {
    throw new PayrollPackError(
      `PL FP age bar needs a birth year 1900–${tables.year} (emp pl_rok_urodzenia), got ${yob}`,
    );
  }
  const ageByYear = tables.year - yob;
  if (ageByYear <= 26) {
    throw new PayrollPackError(
      `PL refuses: the employee turns 26 or less in ${tables.year}, so ulga dla młodych `
      + "(under-26 exemption) may apply — it needs the exemption-claim channel "
      + "plus YTD against its limit, and the engine prices the standard scale only "
      + `(see ${tables.refusedListName}).`,
    );
  }

  // Annual emerytalne/rentowe room under level pay: prior months priced the
  // same base, so remaining = limit − (month − 1) × brut.
  const month = monthOf(input.payDate);
  const limit = U(tables.limitAnnual);
  const prior = brut * BigInt(month - 1);
  const remaining = limit - prior;
  const podstawaSpol = remaining <= 0n ? 0n : brut < remaining ? brut : remaining;

  const emerytEe = lineOf(podstawaSpol, rate6(tables.emerytalneEe));
  const emerytEr = lineOf(podstawaSpol, rate6(tables.emerytalneEr));
  const rentEe = lineOf(podstawaSpol, rate6(tables.rentoweEe));
  const rentEr = lineOf(podstawaSpol, rate6(tables.rentoweEr));
  // Chorobowe prices the full revenue: the art. 19 ust. 1 cap covers
  // emerytalne/rentowe only.
  const chorEe = lineOf(brut, rate6(tables.choroboweEe));
  const zusEe = emerytEe + rentEe + chorEe;

  // Zdrowotna: 9 % of revenue minus the employee's social contributions,
  // uncapped (art. 81 ust. 5–6).
  const podstawaZdr = brut - zusEe;
  const zdrowotna = lineOf(podstawaZdr, rate6(tables.zdrowotna));

  // FP/FS age bar: certain liability below 55-by-year, certain exemption
  // above 60-by-year, refusal in between (no sex/birth-month channel).
  let fpZwolnioneWiek = false;
  if (ageByYear >= 55 && ageByYear <= 60) {
    throw new PayrollPackError(
      `PL FP/FS refuses: birth year ${yob} lands in the 55–60 band where ${tables.fpAgeCite} `
      + "splits the exemption by sex (55 women / 60 men) — no pack channel carries "
      + "the employee's sex or birth month, so the engine cannot tell whether FP/FS "
      + `are due (see ${tables.refusedListName}).`,
    );
  }
  if (ageByYear > 60) fpZwolnioneWiek = true;

  // FP/FS base is uncapped but needs the minimum wage for the month.
  const fpNalezne = !fpZwolnioneWiek && brut >= minWageForMonth(tables, input.payDate);
  const fp = fpNalezne ? lineOf(brut, rate6(tables.fp)) : 0n;
  const fs = fpNalezne ? lineOf(brut, rate6(tables.fs)) : 0n;
  // FGŚP: same uncapped base, no wage threshold. Where the year's law
  // carries the art. 9b ust. 2 age bar (`fgspAgeBar`), seniors certain
  // past 60-by-year are exempt like FP/FS; the 55–60 band already refused
  // above, so reaching here with fpZwolnioneWiek means certain exemption.
  const fgsp = tables.fgspAgeBar && fpZwolnioneWiek ? 0n : lineOf(brut, rate6(tables.fgsp));

  // Tenant-declared wypadkowe: priced when declared, zero otherwise.
  const wypPct = input.wypadkowePct ?? null;
  let wypadkoweEr = 0n;
  if (wypPct !== null && wypPct !== "") {
    if (!/^\d+(\.\d{1,4})?$/.test(wypPct)) {
      throw new PayrollPackError(
        `PL wypadkowe rate is not a percent with at most four decimals: "${wypPct}"`,
      );
    }
    const [whole = "0", fraction = ""] = wypPct.split(".");
    const pct6 = BigInt(whole) * RATE6 + BigInt((fraction + "000000").slice(0, 6));
    if (pct6 < 0n || pct6 > 100n * RATE6) {
      throw new PayrollPackError(`PL wypadkowe rate out of range 0–100 %: "${wypPct}"`);
    }
    wypadkoweEr = lineOf(brut, pct6 / 100n);
  }

  return {
    podstawaSpoleczne: D(podstawaSpol),
    emerytEe: D(emerytEe),
    emerytEr: D(emerytEr),
    rentEe: D(rentEe),
    rentEr: D(rentEr),
    chorEe: D(chorEe),
    zusEe: D(zusEe),
    podstawaZdrowotna: D(podstawaZdr),
    zdrowotna: D(zdrowotna),
    fpNalezne,
    fpZwolnioneWiek,
    fp: D(fp),
    fs: D(fs),
    fgsp: D(fgsp),
    wypadkoweEr: D(wypadkoweEr),
  };
}

/** Historical input alias — the shape is year-agnostic (see PlZusCalcInput). */
export type PlZus2026Input = PlZusCalcInput;
/** Historical result alias — the shape is year-agnostic (see PlZusCalcResult). */
export type PlZus2026Result = PlZusCalcResult;

/**
 * 2026 entry point. The landed gate runs first, so every 2026 refusal
 * message is exactly the landed one; the shared core then prices from
 * the 2026 tables.
 */
export function calculatePlZus2026(input: PlZus2026Input): PlZus2026Result {
  plTableYearForPayDate(input.payDate);
  return calculatePlZusWithTables(input, PL_2026_TABLES);
}

/** 2025 entry point: the shared core on the 2025 tables. */
export function calculatePlZus2025(input: PlZusCalcInput): PlZusCalcResult {
  return calculatePlZusWithTables(input, PL_2025_TABLES);
}

/** 2024 entry point: the shared core on the 2024 tables. */
export function calculatePlZus2024(input: PlZusCalcInput): PlZusCalcResult {
  return calculatePlZusWithTables(input, PL_2024_TABLES);
}

export type PlKupVariant = "miejscowy" | "dojazd";
export type PlPomniejszenie = "1/12" | "1/24" | "1/36" | "nie";

/**
 * Year-agnostic PIT input: the shape is identical for every transcribed
 * year (the year-suffixed alias below is historical).
 */
export interface PlPitCalcInput {
  /** Miesięczny przychód, decimal. */
  brut: string;
  /** Employee social contributions priced this month (art. 32 ust. 4), decimal. */
  zusEe: string;
  /** KUP variant from the pl_pit2 certificate. */
  kup: PlKupVariant;
  /** Oświadczenie reduction from the pl_pit2 certificate. */
  pomniejszenie: PlPomniejszenie;
  /** Pay date, ISO YYYY-MM-DD — selects the calendar month for the YTD test. */
  payDate: string;
  /** Usual pay periodicity; 12 = monthly, the only priced shape. */
  periodsPerYear: number;
}

/**
 * Year-agnostic PIT result: the shape is identical for every transcribed
 * year (the year-suffixed alias below is historical).
 */
export interface PlPitCalcResult {
  /** KUP applied for the month, 4dp. */
  kup: string;
  /** Monthly dochód rounded to whole złotych (Ordynacja art. 63 § 1), 4dp. */
  dochod: string;
  /** Dochód priced at 12 % this month (whole złotych), 4dp. */
  podstawa12: string;
  /** Dochód priced at 32 % this month (whole złotych), 4dp. */
  podstawa32: string;
  /** Reduction applied for the month, 4dp. */
  pomniejszenieKwota: string;
  /** Monthly PIT advance, whole złotych floored at zero, 4dp. */
  zaliczka: string;
}

/**
 * The shared PIT engine: prices one month's advance from any transcribed
 * year's tables. The scale (120 000 zł, 12 %/32 %, 3 600 zł) is identical
 * across the transcribed years; the tables are still read, never assumed.
 */
export function calculatePlPitWithTables(
  input: PlPitCalcInput,
  tables: PlYearTables,
): PlPitCalcResult {
  requirePayYear(input.payDate, tables);
  requireMonthly(input.periodsPerYear, tables);
  let brut: bigint;
  let zusEe: bigint;
  try {
    brut = U(input.brut);
  } catch {
    throw new PayrollPackError(`PL PIT brut is not a decimal amount: "${input.brut}"`);
  }
  try {
    zusEe = U(input.zusEe);
  } catch {
    throw new PayrollPackError(`PL PIT zusEe is not a decimal amount: "${input.zusEe}"`);
  }
  if (brut < 0n || zusEe < 0n) {
    throw new PayrollPackError(
      `PL PIT brut and zusEe must be non-negative, got "${input.brut}" / "${input.zusEe}"`,
    );
  }
  const kupUnits =
    input.kup === "miejscowy"
      ? U(tables.kupMiejscowy)
      : input.kup === "dojazd"
        ? U(tables.kupDojazd)
        : null;
  if (kupUnits === null) {
    throw new PayrollPackError(
      `PL PIT needs a KUP variant (miejscowy 250 zł / dojazd 300 zł), got "${input.kup}"`,
    );
  }
  const pomnUnits =
    input.pomniejszenie === "1/12"
      ? U(tables.pomnPelne)
      : input.pomniejszenie === "1/24"
        ? U(tables.pomnPolowa)
        : input.pomniejszenie === "1/36"
          ? U(tables.pomnTrzecia)
          : input.pomniejszenie === "nie"
            ? 0n
            : null;
  if (pomnUnits === null) {
    throw new PayrollPackError(
      `PL PIT needs a pomniejszenie answer (1/12, 1/24, 1/36 or nie), got "${input.pomniejszenie}"`,
    );
  }

  // Dochód (art. 32 ust. 4), floored at zero — a negative monthly dochód
  // prices no advance — then rounded to whole złotych (Ordynacja art. 63).
  const dochodExact = brut - zusEe - kupUnits;
  const dochod = rZloty(dochodExact < 0n ? 0n : dochodExact);

  // 120 000 zł year-to-date test under level pay: prior months priced the
  // same monthly dochód.
  const month = monthOf(input.payDate);
  const prog = U(tables.prog);
  const prior = dochod * BigInt(month - 1);
  let podstawa12 = dochod;
  let podstawa32 = 0n;
  if (prior >= prog) {
    podstawa12 = 0n;
    podstawa32 = dochod;
  } else if (prior + dochod > prog) {
    podstawa12 = prog - prior;
    podstawa32 = dochod - podstawa12;
  }

  // Advance: 12 % / 32 % of the split bases minus the oświadczenie
  // reduction, rounded to whole złotych, floored at zero ("nie więcej niż").
  const raw =
    roundDiv(podstawa12 * rate6(tables.stawkaDolna), RATE6)
    + roundDiv(podstawa32 * rate6(tables.stawkaGorna), RATE6)
    - pomnUnits;
  const zaliczka = rZloty(raw < 0n ? 0n : raw);

  return {
    kup: D(kupUnits),
    dochod: D(dochod),
    podstawa12: D(podstawa12),
    podstawa32: D(podstawa32),
    pomniejszenieKwota: D(pomnUnits),
    zaliczka: D(zaliczka),
  };
}

/** Historical input alias — the shape is year-agnostic (see PlPitCalcInput). */
export type PlPit2026Input = PlPitCalcInput;
/** Historical result alias — the shape is year-agnostic (see PlPitCalcResult). */
export type PlPit2026Result = PlPitCalcResult;

/**
 * 2026 entry point. The landed gate runs first, so every 2026 refusal
 * message is exactly the landed one; the shared core then prices from
 * the 2026 tables.
 */
export function calculatePlPit2026(input: PlPit2026Input): PlPit2026Result {
  plTableYearForPayDate(input.payDate);
  return calculatePlPitWithTables(input, PL_2026_TABLES);
}

/** 2025 entry point: the shared core on the 2025 tables. */
export function calculatePlPit2025(input: PlPitCalcInput): PlPitCalcResult {
  return calculatePlPitWithTables(input, PL_2025_TABLES);
}

/** 2024 entry point: the shared core on the 2024 tables. */
export function calculatePlPit2024(input: PlPitCalcInput): PlPitCalcResult {
  return calculatePlPitWithTables(input, PL_2024_TABLES);
}

/**
 * Pack adapter: reads the month's revenue from the run, the birth year from
 * the employee record, and the oświadczenie + KUP answers from the `pl_pit2`
 * certificate; pushes the PIT advance and every priced ZUS/NFZ line.
 * Refuses untranscribed tax years (anything but 2024–2026), non-monthly
 * periodicity, and any undeclared certificate answer — silence here would
 * be wrong money.
 */
/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. Terms are the PIT/ZUS computation's own
 * (podstawa, składki, zaliczka, fundusze) — see tables-2026.ts.
 */
export const PL_FACTOR_LABELS: Readonly<Record<string, string>> = {
  BRUTTO: "Przychód (brutto)",
  PODSTAWA_SP: "Podstawa wymiaru składek społecznych",
  EMERYT_EE: "Składka emerytalna (pracownik)",
  RENT_EE: "Składka rentowa (pracownik)",
  CHOR_EE: "Składka chorobowa (pracownik)",
  ZUS_EE: "Składki ZUS (pracownik, razem)",
  PODSTAWA_ZDR: "Podstawa wymiaru składki zdrowotnej",
  ZDR: "Składka zdrowotna (NFZ)",
  KUP: "Koszty uzyskania przychodu",
  DOCHOD: "Dochód",
  PODSTAWA_12: "Podstawa opodatkowania (12%)",
  PODSTAWA_32: "Podstawa opodatkowania (32%)",
  POMNIEJSZENIE: "Pomniejszenie zaliczki (oświadczenie)",
  ZALICZKA: "Zaliczka na PIT",
  EMERYT_ER: "Składka emerytalna (pracodawca)",
  RENT_ER: "Składka rentowa (pracodawca)",
  FP: "Fundusz Pracy (pracodawca)",
  FS: "Fundusz Solidarnościowy (pracodawca)",
  FGSP: "FGŚP (pracodawca)",
};

export async function computePlStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const { taxYear, region, run, emp, income, nonPeriodic, periodsPerYear, pushStatutory, certificateFor } = ctx;
  // The edition dispatch: an untranscribed year refuses here, before any
  // rate is touched — never falls through to another year's tables.
  const tables = tablesForYear(taxYear);
  if (region !== "PL") {
    throw new PayrollPackError(
      `PL withholding for region "${region}" is not supported: the pack `
      + "knows one national region, PL — PIT advances and ZUS contributions "
      + "are national. There is no second region to fall back to.",
    );
  }
  const payDate = run["pay_date"];
  if (!payDate) {
    throw new PayrollPackError(
      "PL withholding needs the payment month (run pay_date): the 120 000 zł "
      + `PIT test and the ${groupPl(tables.limitAnnual)} zł ZUS room both resolve year-to-date from it.`,
    );
  }
  requireMonthly(periodsPerYear, tables);

  // Resolved through the pack's employeeFacts declaration: the raw value is
  // untouched (presence and refusal stay here), but a key the pack never
  // declared refuses at authoring time instead of reading undefined forever.
  const yobRaw = empFact("PL", emp, "pl_rok_urodzenia");
  const yob = yobRaw === null || yobRaw === undefined ? NaN : Number(yobRaw);
  if (yobRaw === null || yobRaw === undefined || yobRaw === "" || !Number.isInteger(yob)) {
    throw new PayrollPackError(
      "PL withholding needs the employee's birth year (emp pl_rok_urodzenia): "
      + `the FP/FS age bar (${tables.fpAgeCite}) and the under-26 refusal cannot be decided `
      + "without it, and an unknown age must not fall through to standard pricing.",
    );
  }

  const answers = certificateFor("pl_pit2")?.answers ?? {};
  const kup = answers["kup"];
  if (kup !== "miejscowy" && kup !== "dojazd") {
    throw new PayrollPackError(
      "PL PIT needs an affirmed KUP variant (pl_pit2 … kup = miejscowy 250 zł "
      + "or dojazd 300 zł, art. 22 ust. 2 pkt 1/3): the two amounts differ and "
      + "an undeclared residence must not fall through to 250 zł.",
    );
  }
  const pomniejszenie = answers["pomniejszenie"];
  if (
    pomniejszenie !== "1/12"
    && pomniejszenie !== "1/24"
    && pomniejszenie !== "1/36"
    && pomniejszenie !== "nie"
  ) {
    throw new PayrollPackError(
      "PL PIT needs an affirmed oświadczenie answer (pl_pit2 … pomniejszenie = "
      + "1/12, 1/24, 1/36 or nie, art. 31b): whether the employee filed the "
      + "reduction statement is a certificate answer, and an undeclared answer "
      + "must not fall through to the 300 zł reduction.",
    );
  }

  const base = D(U(income) + U(nonPeriodic === "" ? "0" : nonPeriodic));
  const zus = calculatePlZusWithTables({
    brut: base,
    payDate,
    periodsPerYear,
    rokUrodzenia: yob,
    // No pack channel carries the payer's PKD/ZUS wypadkowe rate: the pure
    // function prices it when declared, but the adapter never declares one.
    wypadkowePct: null,
  }, tables);
  const pit = calculatePlPitWithTables({
    brut: base,
    zusEe: zus.zusEe,
    kup,
    pomniejszenie,
    payDate,
    periodsPerYear,
  }, tables);

  pushStatutory("pit", "deduction", "Zaliczka na podatek dochodowy (PIT)", pit.zaliczka, 110);
  pushStatutory("zus_emeryt", "deduction", "Składka emerytalna (pracownik)", zus.emerytEe, 120);
  pushStatutory("zus_rent", "deduction", "Składka rentowa (pracownik)", zus.rentEe, 121);
  pushStatutory("zus_chor", "deduction", "Składka chorobowa (pracownik)", zus.chorEe, 122);
  pushStatutory("zus_zdr", "deduction", "Składka zdrowotna (NFZ)", zus.zdrowotna, 123);
  pushStatutory("zus_emeryt_er", "employer_contribution", "Składka emerytalna (pracodawca)", zus.emerytEr, 210);
  pushStatutory("zus_rent_er", "employer_contribution", "Składka rentowa (pracodawca)", zus.rentEr, 211);
  pushStatutory("fp_er", "employer_contribution", "Fundusz Pracy (pracodawca)", zus.fp, 212);
  pushStatutory("fs_er", "employer_contribution", "Fundusz Solidarnościowy (pracodawca)", zus.fs, 213);
  pushStatutory("fgsp_er", "employer_contribution", "FGŚP (pracodawca)", zus.fgsp, 214);
  return {
    BRUTTO: base,
    PODSTAWA_SP: zus.podstawaSpoleczne,
    EMERYT_EE: zus.emerytEe,
    RENT_EE: zus.rentEe,
    CHOR_EE: zus.chorEe,
    ZUS_EE: zus.zusEe,
    PODSTAWA_ZDR: zus.podstawaZdrowotna,
    ZDR: zus.zdrowotna,
    KUP: pit.kup,
    DOCHOD: pit.dochod,
    PODSTAWA_12: pit.podstawa12,
    PODSTAWA_32: pit.podstawa32,
    POMNIEJSZENIE: pit.pomniejszenieKwota,
    ZALICZKA: pit.zaliczka,
    EMERYT_ER: zus.emerytEr,
    RENT_ER: zus.rentEr,
    FP: zus.fp,
    FS: zus.fs,
    FGSP: zus.fgsp,
  };
}
