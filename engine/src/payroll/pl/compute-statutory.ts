/**
 * The PL pack's statutory pass: monthly PIT advances (zaliczki) and ZUS/NFZ
 * contributions for calendar 2026.
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
import { fromUnits, roundDiv, toUnits } from "../../money.ts";
import { empFact } from "../employee-facts.ts";
// Side effect: registers PL_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
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

/** Calendar month (1–12) of an ISO pay date already gated to 2026. */
function monthOf(payDate: string): number {
  const month = Number(payDate.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new PayrollPackError(
      `PL pay date has no calendar month 01–12: "${payDate}"`,
    );
  }
  return month;
}

function requireMonthly(periodsPerYear: number): void {
  if (periodsPerYear !== 12) {
    throw new PayrollPackError(
      `PL 2026 prices monthly pay (12 periods per year), got ${periodsPerYear}: `
      + "non-monthly periodicity is refused by name (see PL_REFUSALS_2026).",
    );
  }
}

export interface PlZus2026Input {
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

export interface PlZus2026Result {
  /** Monthly emerytalne/rentowe base after the 282 600 zł room, 4dp. */
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

export function calculatePlZus2026(input: PlZus2026Input): PlZus2026Result {
  plTableYearForPayDate(input.payDate);
  requireMonthly(input.periodsPerYear);
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
  if (!Number.isInteger(yob) || yob < 1900 || yob > 2026) {
    throw new PayrollPackError(
      `PL FP age bar needs a birth year 1900–2026 (emp pl_rok_urodzenia), got ${yob}`,
    );
  }
  const ageByYear = 2026 - yob;
  if (ageByYear <= 26) {
    throw new PayrollPackError(
      "PL refuses: the employee turns 26 or less in 2026, so ulga dla młodych "
      + "(under-26 exemption) may apply — it needs the exemption-claim channel "
      + "plus YTD against its limit, and the engine prices the standard scale only "
      + "(see PL_REFUSALS_2026).",
    );
  }

  // Annual emerytalne/rentowe room under level pay: prior months priced the
  // same base, so remaining = 282 600 − (month − 1) × brut.
  const month = monthOf(input.payDate);
  const limit = U(PL_ROCZNY_LIMIT_2026.annual);
  const prior = brut * BigInt(month - 1);
  const remaining = limit - prior;
  const podstawaSpol = remaining <= 0n ? 0n : brut < remaining ? brut : remaining;

  const emerytEe = lineOf(podstawaSpol, rate6(PL_SKLADKI_PODZIAL_2026.emerytalneEe.rate));
  const emerytEr = lineOf(podstawaSpol, rate6(PL_SKLADKI_PODZIAL_2026.emerytalneEr.rate));
  const rentEe = lineOf(podstawaSpol, rate6(PL_SKLADKI_PODZIAL_2026.rentoweEe.rate));
  const rentEr = lineOf(podstawaSpol, rate6(PL_SKLADKI_PODZIAL_2026.rentoweEr.rate));
  // Chorobowe prices the full revenue: the art. 19 ust. 1 cap covers
  // emerytalne/rentowe only.
  const chorEe = lineOf(brut, rate6(PL_SKLADKI_PODZIAL_2026.choroboweEe.rate));
  const zusEe = emerytEe + rentEe + chorEe;

  // Zdrowotna: 9 % of revenue minus the employee's social contributions,
  // uncapped (art. 81 ust. 5–6).
  const podstawaZdr = brut - zusEe;
  const zdrowotna = lineOf(podstawaZdr, rate6(PL_ZDROWOTNA_2026.rate));

  // FP/FS age bar: certain liability below 55-by-year, certain exemption
  // above 60-by-year, refusal in between (no sex/birth-month channel).
  let fpZwolnioneWiek = false;
  if (ageByYear >= 55 && ageByYear <= 60) {
    throw new PayrollPackError(
      `PL FP/FS refuses: birth year ${yob} lands in the 55–60 band where art. 261 `
      + "splits the exemption by sex (55 women / 60 men) — no pack channel carries "
      + "the employee's sex or birth month, so the engine cannot tell whether FP/FS "
      + "are due (see PL_REFUSALS_2026).",
    );
  }
  if (ageByYear > 60) fpZwolnioneWiek = true;

  // FP/FS base is uncapped but needs the minimum wage for the month.
  const fpNalezne = !fpZwolnioneWiek && brut >= U(PL_MIN_WAGE_2026.monthly);
  const fp = fpNalezne ? lineOf(brut, rate6(PL_FUNDUSZE_2026.fp.rate)) : 0n;
  const fs = fpNalezne ? lineOf(brut, rate6(PL_FUNDUSZE_2026.fs.rate)) : 0n;
  // FGŚP: same uncapped base, no wage threshold.
  const fgsp = lineOf(brut, rate6(PL_FUNDUSZE_2026.fgsp.rate));

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

export type PlKupVariant = "miejscowy" | "dojazd";
export type PlPomniejszenie = "1/12" | "1/24" | "1/36" | "nie";

export interface PlPit2026Input {
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

export interface PlPit2026Result {
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

export function calculatePlPit2026(input: PlPit2026Input): PlPit2026Result {
  plTableYearForPayDate(input.payDate);
  requireMonthly(input.periodsPerYear);
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
      ? U(PL_KUP_2026.miejscowy.miesiecznie)
      : input.kup === "dojazd"
        ? U(PL_KUP_2026.dojazd.miesiecznie)
        : null;
  if (kupUnits === null) {
    throw new PayrollPackError(
      `PL PIT needs a KUP variant (miejscowy 250 zł / dojazd 300 zł), got "${input.kup}"`,
    );
  }
  const pomnUnits =
    input.pomniejszenie === "1/12"
      ? U(PL_PIT_POMNIEJSZENIE_2026.pelne)
      : input.pomniejszenie === "1/24"
        ? U(PL_PIT_POMNIEJSZENIE_2026.polowa)
        : input.pomniejszenie === "1/36"
          ? U(PL_PIT_POMNIEJSZENIE_2026.trzecia)
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
  const prog = U(PL_PIT_SKALA_2026.prog);
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
    roundDiv(podstawa12 * rate6(PL_PIT_SKALA_2026.stawkaDolna.rate), RATE6)
    + roundDiv(podstawa32 * rate6(PL_PIT_SKALA_2026.stawkaGorna.rate), RATE6)
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

/**
 * Pack adapter: reads the month's revenue from the run, the birth year from
 * the employee record, and the oświadczenie + KUP answers from the `pl_pit2`
 * certificate; pushes the PIT advance and every priced ZUS/NFZ line.
 * Refuses anything but taxYear 2026, non-monthly periodicity, and any
 * undeclared certificate answer — silence here would be wrong money.
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
  if (taxYear !== 2026) {
    throw new PayrollPackError(
      `PL withholding for tax year ${taxYear} has not been transcribed `
      + "— the PL payroll pack's only transcribed year is calendar 2026 "
      + "(see engine/src/payroll/pl/tables-2026.ts). Transcribe the year's "
      + "tables before calculating",
    );
  }
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
      + "PIT test and the 282 600 zł ZUS room both resolve year-to-date from it.",
    );
  }
  requireMonthly(periodsPerYear);

  // Resolved through the pack's employeeFacts declaration: the raw value is
  // untouched (presence and refusal stay here), but a key the pack never
  // declared refuses at authoring time instead of reading undefined forever.
  const yobRaw = empFact("PL", emp, "pl_rok_urodzenia");
  const yob = yobRaw === null || yobRaw === undefined ? NaN : Number(yobRaw);
  if (yobRaw === null || yobRaw === undefined || yobRaw === "" || !Number.isInteger(yob)) {
    throw new PayrollPackError(
      "PL withholding needs the employee's birth year (emp pl_rok_urodzenia): "
      + "the FP/FS age bar (art. 261) and the under-26 refusal cannot be decided "
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
  const zus = calculatePlZus2026({
    brut: base,
    payDate,
    periodsPerYear,
    rokUrodzenia: yob,
    // No pack channel carries the payer's PKD/ZUS wypadkowe rate: the pure
    // function prices it when declared, but the adapter never declares one.
    wypadkowePct: null,
  });
  const pit = calculatePlPit2026({
    brut: base,
    zusEe: zus.zusEe,
    kup,
    pomniejszenie,
    payDate,
    periodsPerYear,
  });

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
